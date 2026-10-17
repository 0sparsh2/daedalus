"use client";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/icons";
import { ApiError, api } from "@/lib/client/api";

interface AgentsInfo {
  provider: string;
  providerLabel: string;
  models: Array<{ id: string; label: string; fast: boolean }>;
  builder: {
    model: string | null;
    modelLabel: string | null;
    runs: number;
    builds: number;
    plans: number;
    succeeded: number;
    toolCalls: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
  subagents: { model: string | null; research: { calls: number; failed: number; avgMs: number }; explore: { calls: number; failed: number; avgMs: number } };
  router?: { routes: Record<"chat" | "ask" | "plan" | "build", number>; byModel: number; byRule: number; avgModelMs: number };
}

const GUARD_RAILS: Array<[IconName, string, string]> = [
  ["shield", "Automatic check", "A build can't finish until it type-checks, builds and renders."],
  ["key", "Keys stay in the gateway", "Your model key never enters this project's sandbox."],
  ["loop", "Loop guard", "Three identical failing tool calls in a row trigger a change of approach."],
  ["alert", "Blocked commands", "Deleting the filesystem, fork bombs, power commands and git push are refused."],
  ["history", "Every run is a version", "Changes are committed after each run, so any version can be restored."],
];

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The agent team working on this project, their models, and the project's instructions. */
export function AgentsPanel({ projectId, refreshKey, hasSandbox }: { projectId: string; refreshKey: number; hasSandbox: boolean }) {
  const [info, setInfo] = useState<AgentsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instr, setInstr] = useState<{ value: string; saved: string } | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<AgentsInfo>(`/api/projects/${projectId}/agents`)
      .then((r) => !cancelled && setInfo(r))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Couldn't load agents"));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  useEffect(() => {
    if (!hasSandbox) return;
    let cancelled = false;
    api<{ content: string | null }>(`/api/projects/${projectId}/instructions`)
      .then((r) => !cancelled && setInstr({ value: r.content ?? "", saved: r.content ?? "" }))
      .catch(() => !cancelled && setInstr({ value: "", saved: "" }));
    return () => {
      cancelled = true;
    };
  }, [projectId, hasSandbox, refreshKey]);

  async function setSubagentModel(model: string) {
    if (!info) return;
    setInfo({ ...info, subagents: { ...info.subagents, model } });
    await api(`/api/projects/${projectId}/agents`, { method: "PATCH", json: { subagentModel: model } }).catch(() => {});
  }

  async function saveInstructions() {
    if (!instr) return;
    setSaving("saving");
    setSaveError(null);
    try {
      await api(`/api/projects/${projectId}/instructions`, { method: "PUT", json: { content: instr.value } });
      setInstr({ value: instr.value, saved: instr.value });
      setSaving("saved");
    } catch (e) {
      setSaving("idle");
      setSaveError(e instanceof ApiError ? e.message : "Couldn't save");
    }
  }

  if (error) return <div className="empty"><div className="error-text">{error}</div></div>;
  if (!info) return <div className="empty"><span className="spin" /></div>;

  const b = info.builder;
  return (
    <div className="agents">
      <section aria-labelledby="team-h" className="agents-sec">
        <h2 id="team-h" className="label">Who works on this project</h2>
        <div className="agent-cards">
          {info.router && (
            <article className="agent-card">
              <div className="agent-h">
                <span className="agent-ic sub"><Icon name="flow" /></span>
                <div>
                  <b>Turn router</b>
                  <div className="muted" style={{ fontSize: 13 }}>Reads each message first and picks who handles it: chat, answer (read-only), plan or build</div>
                </div>
              </div>
              <dl className="kv">
                <dt>Turns</dt>
                <dd>
                  {info.router.routes.chat} chat · {info.router.routes.ask} answer · {info.router.routes.plan} plan · {info.router.routes.build} build
                </dd>
                <dt>Decided by</dt>
                <dd>
                  {info.router.byRule} rule or action (free) · {info.router.byModel} fast model{info.router.byModel ? ` (avg ${(info.router.avgModelMs / 1000).toFixed(1)}s)` : ""}
                </dd>
              </dl>
            </article>
          )}
          <article className="agent-card">
            <div className="agent-h">
              <span className="agent-ic"><Icon name="bolt" /></span>
              <div>
                <b>Builder</b>
                <div className="muted" style={{ fontSize: 13 }}>Plans, writes code, runs tools, checks its work</div>
              </div>
            </div>
            <dl className="kv">
              <dt>Model</dt>
              <dd>{b.modelLabel ? `${b.modelLabel} · ${info.providerLabel}` : "Connect a model"}</dd>
              <dt>Runs</dt>
              <dd>{b.runs} ({b.plans} plan, {b.builds} build, {b.succeeded} succeeded)</dd>
              <dt>Work</dt>
              <dd>{b.llmCalls} model calls · {b.toolCalls} tool calls</dd>
              <dt>Tokens</dt>
              <dd>{fmt(b.inputTokens)} in / {fmt(b.outputTokens)} out</dd>
            </dl>
            <p className="hint" style={{ margin: 0 }}>Change the builder&apos;s model from the model picker in the composer.</p>
          </article>
          {(
            [
              ["research", "Research sub-agent", "Searches the web and reads docs in its own context; returns a short answer with sources", "globe"],
              ["explore", "Explore sub-agent", "Maps the codebase read-only and reports where to make a change", "search"],
            ] as const
          ).map(([key, title, blurb, icon]) => {
            const s = info.subagents[key];
            return (
              <article key={key} className="agent-card">
                <div className="agent-h">
                  <span className="agent-ic sub"><Icon name={icon} /></span>
                  <div>
                    <b>{title}</b>
                    <div className="muted" style={{ fontSize: 13 }}>{blurb}</div>
                  </div>
                </div>
                <dl className="kv">
                  <dt>Called</dt>
                  <dd>{s.calls} time{s.calls === 1 ? "" : "s"}{s.failed ? ` · ${s.failed} failed` : ""}{s.calls ? ` · avg ${(s.avgMs / 1000).toFixed(1)}s` : ""}</dd>
                </dl>
              </article>
            );
          })}
        </div>
        <label className="field" style={{ maxWidth: 420 }}>
          <span>Sub-agent model ({info.providerLabel})</span>
          <select className="select" value={info.subagents.model ?? ""} onChange={(e) => void setSubagentModel(e.target.value)}>
            {info.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.fast ? " · fast" : ""}
              </option>
            ))}
          </select>
          <span className="hint">Sub-agents do focused side tasks, so a fast model usually works best and keeps runs cheap.</span>
        </label>
      </section>

      <section aria-labelledby="instr-h" className="agents-sec">
        <h2 id="instr-h" className="label">Project instructions (AGENTS.md)</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          The builder reads these at the start of every run, the same convention Codex and Claude Code use. Put your conventions here: tone,
          libraries to prefer, things to avoid.
        </p>
        {!hasSandbox ? (
          <p className="hint">Available once the project has started.</p>
        ) : instr === null ? (
          <span className="spin" />
        ) : (
          <>
            <label className="sr-only" htmlFor="agents-md">AGENTS.md</label>
            <textarea id="agents-md" className="input mono" style={{ minHeight: 220, fontSize: 13, lineHeight: 1.5 }} value={instr.value} onChange={(e) => { setInstr({ ...instr, value: e.target.value }); setSaving("idle"); }} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn primary" disabled={instr.value === instr.saved || saving === "saving"} onClick={() => void saveInstructions()}>
                {saving === "saving" && <span className="spin" />} Save instructions
              </button>
              {saving === "saved" && <span className="hint" role="status">Saved. The next run uses them.</span>}
              {saveError && <span className="error-text">{saveError}</span>}
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="rails-h" className="agents-sec">
        <h2 id="rails-h" className="label">Always on</h2>
        <ul className="rails">
          {GUARD_RAILS.map(([icon, title, body]) => (
            <li key={title}>
              <Icon name={icon} size={15} />
              <div>
                <b>{title}</b>
                <div className="muted" style={{ fontSize: 13 }}>{body}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
