"use client";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import { ApiError, api } from "@/lib/client/api";
import { describeRule, type Rule, type RulePreset } from "@/lib/rules";
import type { Suggestion as SuggestionData } from "@/lib/suggestions";
import { SuggestionView } from "./tool-cards";

export type Section = "kits" | "connections" | "skills" | "rules" | "memory" | "improve";

const SECTIONS: Array<[Section, string]> = [
  ["kits", "Kits"],
  ["connections", "Connections"],
  ["skills", "Skills"],
  ["rules", "Rules that always run"],
  ["memory", "Instructions & memory"],
  ["improve", "Improve"],
];

/**
 * Customize: how Daedalus works on this project. Everything here is a standard, portable
 * format (SKILL.md files in the repo, AGENTS.md, MCP servers), so nothing is locked in.
 */
export function CustomizePanel({
  projectId,
  hasSandbox,
  refreshKey,
  initialSection = "connections",
  onReview,
  onSuggestionsChanged,
}: {
  projectId: string;
  hasSandbox: boolean;
  refreshKey: number;
  initialSection?: Section;
  /** Starts a review turn in the chat; absent while a run is going. */
  onReview?(): void;
  onSuggestionsChanged?(): void;
}) {
  const [section, setSection] = useState<Section>(initialSection);
  return (
    <div className="agents">
      <div className="mode" role="group" aria-label="Customize sections" style={{ justifySelf: "start" }}>
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={section === id} onClick={() => setSection(id)}>
            {label}
          </button>
        ))}
      </div>
      {section === "kits" && <KitsSection projectId={projectId} onOpen={setSection} />}
      {section === "connections" && <ConnectionsSection projectId={projectId} />}
      {section === "skills" && <SkillsSection projectId={projectId} hasSandbox={hasSandbox} refreshKey={refreshKey} />}
      {section === "rules" && <RulesSection projectId={projectId} refreshKey={refreshKey} />}
      {section === "memory" && <MemorySection projectId={projectId} refreshKey={refreshKey} />}
      {section === "improve" && <ImproveSection projectId={projectId} refreshKey={refreshKey} onReview={onReview} onChanged={onSuggestionsChanged} />}
    </div>
  );
}

interface SkillsInfo {
  builtin: Array<{ name: string; description: string; enabled: boolean; overridden: boolean }>;
  project: Array<{ name: string; description: string; path?: string }>;
  hasSandbox: boolean;
}

const EMPTY_FORM = { name: "", description: "", body: "" };

function SkillsSection({ projectId, hasSandbox, refreshKey }: { projectId: string; hasSandbox: boolean; refreshKey: number }) {
  const [info, setInfo] = useState<SkillsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, string>>({});
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<SkillsInfo>(`/api/projects/${projectId}/skills`)
      .then((r) => !cancelled && setInfo(r))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Couldn't load skills"));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, reload]);

  const view = useCallback(
    async (name: string) => {
      if (open[name] !== undefined) {
        setOpen((o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== name)));
        return;
      }
      const r = await api<{ content: string }>(`/api/projects/${projectId}/skills?name=${encodeURIComponent(name)}`).catch(() => null);
      setOpen((o) => ({ ...o, [name]: r?.content ?? "Couldn't load this skill." }));
    },
    [open, projectId],
  );

  async function edit(name: string) {
    const r = await api<{ name: string; description: string; body: string }>(`/api/projects/${projectId}/skills?name=${encodeURIComponent(name)}`).catch(() => null);
    if (!r) return;
    setForm({ name: r.name, description: r.description, body: r.body });
    setEditing(name);
    setFormError(null);
    document.getElementById("skill-name")?.focus();
  }

  async function save() {
    setSaving(true);
    setFormError(null);
    try {
      await api(`/api/projects/${projectId}/skills`, { method: "POST", json: form });
      setForm(EMPTY_FORM);
      setEditing(null);
      setOpen({});
      setReload((n) => n + 1);
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : "Couldn't save the skill");
    } finally {
      setSaving(false);
    }
  }

  async function remove(name: string) {
    setConfirmDelete(null);
    await api(`/api/projects/${projectId}/skills?name=${encodeURIComponent(name)}`, { method: "DELETE" }).catch((e) => setError(e instanceof ApiError ? e.message : "Couldn't delete"));
    setReload((n) => n + 1);
  }

  async function toggle(name: string, enabled: boolean) {
    setInfo((i) => (i ? { ...i, builtin: i.builtin.map((b) => (b.name === name ? { ...b, enabled } : b)) } : i));
    await api(`/api/projects/${projectId}/skills`, { method: "PATCH", json: { name, enabled } }).catch(() => setReload((n) => n + 1));
  }

  if (error) return <div className="error-text">{error}</div>;
  if (!info) return <span className="spin" />;

  return (
    <>
      <section aria-labelledby="skills-h" className="agents-sec">
        <h2 id="skills-h" className="label">Skills</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Playbooks for how a kind of work should be done. Daedalus sees each skill&apos;s name and description, and loads the full instructions when a
          task matches. Your skills are <span className="mono">SKILL.md</span> files in the project (<span className="mono">.agents/skills/</span>), so other
          agent tools can use them too.
        </p>
        <div className="agent-cards">
          {info.project.map((s) => (
            <article key={s.name} className="agent-card">
              <div className="agent-h">
                <span className="agent-ic"><Icon name="file" /></span>
                <div style={{ minWidth: 0 }}>
                  <b className="mono">{s.name}</b>
                  <div className="muted" style={{ fontSize: 13 }}>{s.description}</div>
                </div>
              </div>
              {open[s.name] !== undefined && <pre className="codeblock">{open[s.name]}</pre>}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn sm" aria-expanded={open[s.name] !== undefined} onClick={() => void view(s.name)}>
                  {open[s.name] !== undefined ? "Hide" : "View"}
                </button>
                <button className="btn sm" onClick={() => void edit(s.name)}>Edit</button>
                {confirmDelete === s.name ? (
                  <>
                    <button className="btn sm danger" onClick={() => void remove(s.name)}>Delete {s.name}</button>
                    <button className="btn sm ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : (
                  <button className="btn sm ghost" onClick={() => setConfirmDelete(s.name)}>Delete</button>
                )}
              </div>
            </article>
          ))}
          {info.project.length === 0 && <p className="hint" style={{ margin: 0 }}>No project skills yet. Add one below, or let Daedalus use the built-in ones.</p>}
        </div>
      </section>

      <section aria-labelledby="skill-form-h" className="agents-sec">
        <h2 id="skill-form-h" className="label">{editing ? `Edit ${editing}` : "New skill"}</h2>
        {!hasSandbox ? (
          <p className="hint">Available once the project has started.</p>
        ) : (
          <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
            <label className="field">
              <span>Name</span>
              <input id="skill-name" className="input mono" placeholder="brand-voice" value={form.name} readOnly={Boolean(editing)} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
              <span className="hint">Lowercase words joined by hyphens.</span>
            </label>
            <label className="field">
              <span>When to use it</span>
              <input className="input" placeholder="Write copy the way our brand talks. Use for any customer-facing text." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              <span className="hint">Daedalus decides from this line whether the skill applies, so say what it does and when.</span>
            </label>
            <label className="field">
              <span>Instructions</span>
              <textarea className="input mono" style={{ minHeight: 180, fontSize: 13, lineHeight: 1.5 }} placeholder={"- Warm and short: two paragraphs at most.\n- No jargon, no exclamation marks.\n- Sign off as \"The Acme team\"."} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn primary" disabled={saving || !form.name || !form.description || !form.body} onClick={() => void save()}>
                {saving && <span className="spin" />} {editing ? "Save changes" : "Add skill"}
              </button>
              {editing && (
                <button className="btn ghost" onClick={() => { setEditing(null); setForm(EMPTY_FORM); }}>Cancel</button>
              )}
              {formError && <span className="error-text" role="alert">{formError}</span>}
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="builtin-h" className="agents-sec">
        <h2 id="builtin-h" className="label">Built-in skills</h2>
        <div className="agent-cards">
          {info.builtin.map((s) => (
            <article key={s.name} className="agent-card">
              <div className="agent-h">
                <span className="agent-ic sub"><Icon name="sparkle" /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <b className="mono">{s.name}</b>
                  <div className="muted" style={{ fontSize: 13 }}>{s.description}</div>
                  {s.overridden && <div className="hint">Your project has its own {s.name} skill, which is used instead.</div>}
                </div>
              </div>
              {open[s.name] !== undefined && <pre className="codeblock">{open[s.name]}</pre>}
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={s.enabled} onChange={(e) => void toggle(s.name, e.target.checked)} /> On for this project
                </label>
                <button className="btn sm ghost" aria-expanded={open[s.name] !== undefined} onClick={() => void view(s.name)}>
                  {open[s.name] !== undefined ? "Hide" : "View"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

type RuleDraft = { event: Rule["event"]; label: string; command: string; pattern: string; reason: string; glob: string };
const EMPTY_RULE: RuleDraft = { event: "before_finish", label: "", command: "", pattern: "", reason: "", glob: "src/**/*" };
const WHEN: Array<[Rule["event"], string]> = [
  ["before_finish", "Daedalus is about to finish a change"],
  ["before_command", "Daedalus is about to run a command"],
  ["after_change", "a file changes"],
];
const newId = () => Math.random().toString(36).slice(2, 10);

function draftToRule(d: RuleDraft): Rule {
  const base = { id: newId(), enabled: true, label: d.label.trim() || undefined };
  if (d.event === "before_finish") return { ...base, event: "before_finish", command: d.command.trim() };
  if (d.event === "before_command") return { ...base, event: "before_command", pattern: d.pattern.trim(), reason: d.reason.trim() || undefined };
  return { ...base, event: "after_change", command: d.command.trim(), glob: d.glob.trim() || "**/*" };
}

function RulesSection({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [presets, setPresets] = useState<RulePreset[]>([]);
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ rules: Rule[]; presets: RulePreset[] }>(`/api/projects/${projectId}/rules`)
      .then((r) => {
        if (cancelled) return;
        setRules(r.rules);
        setPresets(r.presets);
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Couldn't load rules"));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  async function save(next: Rule[]) {
    const before = rules;
    setRules(next);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/rules`, { method: "PUT", json: { rules: next } });
    } catch (e) {
      setRules(before);
      setError(e instanceof ApiError ? e.message : "Couldn't save the rules");
    }
  }

  if (!rules) return error ? <div className="error-text">{error}</div> : <span className="spin" />;
  const unusedPresets = presets.filter((p) => !rules.some((r) => r.label === p.label));
  const draftValid = draft.event === "before_command" ? Boolean(draft.pattern.trim()) : Boolean(draft.command.trim());

  return (
    <>
      <section aria-labelledby="rules-h" className="agents-sec">
        <h2 id="rules-h" className="label">Rules that always run</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Instructions and skills are requests. <b>Rules always run</b>: Daedalus enforces them on every build, whatever the model decides. They&apos;re stored
          in Daedalus, so the agent can&apos;t edit them away.
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          {rules.map((r) => (
            <div key={r.id} className="agent-card" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "inline-flex", gap: 8, alignItems: "center", flex: 1, minWidth: 220 }}>
                <input type="checkbox" checked={r.enabled !== false} onChange={(e) => void save(rules.map((x) => (x.id === r.id ? { ...x, enabled: e.target.checked } : x)))} />
                <span>
                  <b>{r.label || describeRule(r)}</b>
                  {r.label && <span className="muted mono" style={{ display: "block", fontSize: 12.5 }}>{describeRule(r)}</span>}
                </span>
              </label>
              <button className="btn sm ghost" onClick={() => void save(rules.filter((x) => x.id !== r.id))} aria-label={`Remove rule ${r.label || describeRule(r)}`}>
                Remove
              </button>
            </div>
          ))}
          {rules.length === 0 && <p className="hint" style={{ margin: 0 }}>No rules yet. The built-in automatic check (type check, build, preview) always runs.</p>}
        </div>
        {error && <span className="error-text" role="alert">{error}</span>}
      </section>

      {unusedPresets.length > 0 && (
        <section aria-labelledby="presets-h" className="agents-sec">
          <h2 id="presets-h" className="label">Common rules</h2>
          <div className="agent-cards">
            {unusedPresets.map((p) => (
              <article key={p.label} className="agent-card">
                <b>{p.label}</b>
                <span className="muted mono" style={{ fontSize: 12.5 }}>{describeRule({ ...p, id: "x", enabled: true } as Rule)}</span>
                <button className="btn sm" style={{ justifySelf: "start" }} onClick={() => void save([...rules, { ...p, id: newId(), enabled: true } as Rule])}>
                  Add rule
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="newrule-h" className="agents-sec">
        <h2 id="newrule-h" className="label">New rule</h2>
        <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
          <label className="field">
            <span>When</span>
            <select className="select" value={draft.event} onChange={(e) => setDraft({ ...draft, event: e.target.value as Rule["event"] })}>
              {WHEN.map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
          {draft.event === "before_command" ? (
            <>
              <label className="field">
                <span>Block commands that start with</span>
                <input className="input mono" placeholder="npm install" value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} />
                <span className="hint">Use * as a wildcard to match the whole command, for example <span className="mono">rm -rf *</span>.</span>
              </label>
              <label className="field">
                <span>Why (shown to the agent)</span>
                <input className="input" placeholder="Ask me before adding dependencies." value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
              </label>
            </>
          ) : (
            <>
              {draft.event === "after_change" && (
                <label className="field">
                  <span>Files</span>
                  <input className="input mono" placeholder="src/**/*.{ts,tsx}" value={draft.glob} onChange={(e) => setDraft({ ...draft, glob: e.target.value })} />
                </label>
              )}
              <label className="field">
                <span>{draft.event === "before_finish" ? "Run this command; it must pass" : "Run this command on the file"}</span>
                <input className="input mono" placeholder={draft.event === "before_finish" ? "npm test" : "npx --yes prettier --write {file}"} value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
                {draft.event === "after_change" && <span className="hint"><span className="mono">{"{file}"}</span> is replaced by the changed file&apos;s path.</span>}
              </label>
            </>
          )}
          <label className="field">
            <span>Name (optional)</span>
            <input className="input" placeholder="Run the tests" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </label>
          <div>
            <button className="btn primary" disabled={!draftValid} onClick={() => { void save([...rules, draftToRule(draft)]); setDraft(EMPTY_RULE); }}>
              Add rule
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

interface ConnectionInfo {
  id: string;
  name: string;
  url: string;
  read_only: boolean;
  enabled: boolean;
  tools: Array<{ name: string; description: string; readOnly: boolean }>;
  status: "ok" | "error";
  error: string | null;
}
interface Suggestion {
  name: string;
  url: string;
  description: string;
  readOnly: boolean;
}

function ConnectionsSection({ projectId }: { projectId: string }) {
  const [list, setList] = useState<{ connections: ConnectionInfo[]; suggested: Suggestion[] } | null>(null);
  const [form, setForm] = useState({ name: "", url: "", token: "", readOnly: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<{ connections: ConnectionInfo[]; suggested: Suggestion[] }>(`/api/projects/${projectId}/connections`)
      .then((r) => !cancelled && setList(r))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "Couldn't load connections"));
    return () => {
      cancelled = true;
    };
  }, [projectId, reload]);

  async function add(body: { name: string; url: string; token?: string; readOnly: boolean }, key: string) {
    setBusy(key);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/connections`, { method: "POST", json: body });
      setForm({ name: "", url: "", token: "", readOnly: false });
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't connect");
    } finally {
      setBusy(null);
    }
  }

  async function patch(id: string, body: Record<string, boolean>) {
    setBusy(id);
    const r = await api<{ ok: boolean; error?: string }>(`/api/projects/${projectId}/connections`, { method: "PATCH", json: { id, ...body } }).catch(() => null);
    if (r && r.ok === false && r.error) setError(r.error);
    setBusy(null);
    setReload((n) => n + 1);
  }

  async function remove(id: string) {
    await api(`/api/projects/${projectId}/connections?id=${id}`, { method: "DELETE" }).catch(() => {});
    setReload((n) => n + 1);
  }

  if (!list) return error ? <div className="error-text">{error}</div> : <span className="spin" />;

  return (
    <>
      <section aria-labelledby="conn-h" className="agents-sec">
        <h2 id="conn-h" className="label">Connections</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Connect services through MCP, the open standard for giving agents tools. Daedalus calls them from its own server, never from your app&apos;s
          sandbox, and every call shows in the trace. Tools that only read data work in any turn; tools that change things only while building.
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          {list.connections.map((c) => (
            <article key={c.id} className="agent-card">
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <span className="agent-ic"><Icon name="globe" /></span>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <b>{c.name}</b> {c.status === "error" ? <span className="error-text">· can&apos;t reach it</span> : <span className="muted">· {c.tools.length} tool{c.tools.length === 1 ? "" : "s"}</span>}
                  <div className="muted mono" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>{c.url}</div>
                  {c.error && c.status === "error" && <div className="hint">{c.error}</div>}
                </div>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={c.enabled} onChange={(e) => void patch(c.id, { enabled: e.target.checked })} /> On
                </label>
              </div>
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13.5 }}>
                <input type="checkbox" checked={c.read_only} onChange={(e) => void patch(c.id, { readOnly: e.target.checked })} /> This service only reads data (its tools can be used while planning and answering)
              </label>
              {open === c.id && (
                <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, fontSize: 13 }}>
                  {c.tools.map((t) => (
                    <li key={t.name}>
                      <span className="mono">{t.name}</span>
                      {(t.readOnly || c.read_only) && <span className="muted"> · read-only</span>}
                      <div className="muted">{t.description.slice(0, 200)}</div>
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn sm" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? "Hide tools" : "Show tools"}</button>
                <button className="btn sm" disabled={busy === c.id} onClick={() => void patch(c.id, { refresh: true })}>{busy === c.id && <span className="spin" />} Check again</button>
                <button className="btn sm ghost" onClick={() => void remove(c.id)} aria-label={`Remove ${c.name}`}>Remove</button>
              </div>
            </article>
          ))}
          {list.connections.length === 0 && <p className="hint" style={{ margin: 0 }}>Nothing connected yet.</p>}
        </div>
        {error && <span className="error-text" role="alert">{error}</span>}
      </section>

      {list.suggested.length > 0 && (
        <section aria-labelledby="sugg-h" className="agents-sec">
          <h2 id="sugg-h" className="label">Free to connect</h2>
          <div className="agent-cards">
            {list.suggested.map((s) => (
              <article key={s.name} className="agent-card">
                <b>{s.name}</b>
                <span className="muted" style={{ fontSize: 13.5 }}>{s.description}</span>
                <span className="hint mono" style={{ overflowWrap: "anywhere" }}>{s.url}</span>
                <button className="btn sm" style={{ justifySelf: "start" }} disabled={busy === s.name} onClick={() => void add({ name: s.name, url: s.url, readOnly: s.readOnly }, s.name)}>
                  {busy === s.name && <span className="spin" />} Connect
                </button>
              </article>
            ))}
          </div>
          <p className="hint" style={{ margin: 0 }}>These are third-party services: when the agent uses them, its queries go to them.</p>
        </section>
      )}

      <section aria-labelledby="custom-conn-h" className="agents-sec">
        <h2 id="custom-conn-h" className="label">Add an MCP server</h2>
        <div style={{ display: "grid", gap: 10, maxWidth: 720 }}>
          <label className="field">
            <span>Name</span>
            <input className="input mono" placeholder="linear" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} />
          </label>
          <label className="field">
            <span>Server address</span>
            <input className="input mono" placeholder="https://mcp.example.com/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </label>
          <label className="field">
            <span>Access token (optional)</span>
            <input className="input mono" type="password" autoComplete="off" placeholder="Sent as a Bearer token" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
            <span className="hint">Stored encrypted and never shown again. Only Daedalus&apos;s server uses it, for this project&apos;s calls.</span>
          </label>
          <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={form.readOnly} onChange={(e) => setForm({ ...form, readOnly: e.target.checked })} /> This service only reads data
          </label>
          <div>
            <button className="btn primary" disabled={!form.name || !form.url || busy === "custom"} onClick={() => void add({ name: form.name, url: form.url, token: form.token || undefined, readOnly: form.readOnly }, "custom")}>
              {busy === "custom" && <span className="spin" />} Connect and list its tools
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

interface Memory {
  id: string;
  project_id: string | null;
  text: string;
  source: "agent" | "user";
  status: "proposed" | "kept" | "dismissed";
}

function MemorySection({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [instr, setInstr] = useState<{ value: string; saved: string } | null>(null);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [draft, setDraft] = useState({ text: "", scope: "project" as "project" | "me" });
  const [note, setNote] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<{ instructions: string }>("/api/me/instructions")
      .then((r) => !cancelled && setInstr({ value: r.instructions, saved: r.instructions }))
      .catch(() => !cancelled && setInstr({ value: "", saved: "" }));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api<{ memories: Memory[] }>(`/api/projects/${projectId}/memories`)
      .then((r) => !cancelled && setMemories(r.memories))
      .catch(() => !cancelled && setMemories([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, reload]);

  async function saveInstructions() {
    if (!instr) return;
    await api("/api/me/instructions", { method: "PUT", json: { instructions: instr.value } })
      .then(() => {
        setInstr({ value: instr.value, saved: instr.value });
        setNote("Saved. Every project uses them from the next turn.");
      })
      .catch((e) => setNote(e instanceof ApiError ? e.message : "Couldn't save"));
  }

  async function decide(id: string, status: "kept" | "dismissed") {
    setMemories((m) => m?.map((x) => (x.id === id ? { ...x, status } : x)) ?? m);
    await api(`/api/projects/${projectId}/memories`, { method: "PATCH", json: { id, status } }).catch(() => setReload((n) => n + 1));
    if (status === "dismissed") setReload((n) => n + 1);
  }

  async function add() {
    await api(`/api/projects/${projectId}/memories`, { method: "POST", json: draft }).catch(() => {});
    setDraft({ text: "", scope: draft.scope });
    setReload((n) => n + 1);
  }

  const proposed = memories?.filter((m) => m.status === "proposed") ?? [];
  const kept = memories?.filter((m) => m.status === "kept") ?? [];

  return (
    <>
      <section aria-labelledby="me-instr-h" className="agents-sec">
        <h2 id="me-instr-h" className="label">Your instructions (all projects)</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          How Daedalus should work with you, in every project. This project&apos;s own instructions are its <span className="mono">AGENTS.md</span>, in the
          Agents tab. Instructions are requests; for anything that must happen every time, add a rule.
        </p>
        {instr === null ? (
          <span className="spin" />
        ) : (
          <>
            <label className="sr-only" htmlFor="me-instructions">Your instructions</label>
            <textarea id="me-instructions" className="input" style={{ minHeight: 120, maxWidth: 720 }} placeholder={"Explain things simply; I'm not a developer.\nUse British spelling.\nPrefer calm colours."} value={instr.value} onChange={(e) => { setInstr({ ...instr, value: e.target.value }); setNote(null); }} />
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="btn primary" disabled={instr.value === instr.saved} onClick={() => void saveInstructions()}>Save instructions</button>
              {note && <span className="hint" role="status">{note}</span>}
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="mem-h" className="agents-sec">
        <h2 id="mem-h" className="label">Memory</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Things Daedalus learned while working with you. It only proposes them; nothing is used until you keep it.
        </p>
        {memories === null ? (
          <span className="spin" />
        ) : (
          <div style={{ display: "grid", gap: 8, maxWidth: 820 }}>
            {proposed.map((m) => (
              <div key={m.id} className="memory-card">
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>Proposed{m.project_id ? "" : " · all projects"}</span>
                  <span style={{ display: "block" }}>{m.text}</span>
                </span>
                <button className="btn sm primary" onClick={() => void decide(m.id, "kept")}>Keep</button>
                <button className="btn sm ghost" onClick={() => void decide(m.id, "dismissed")}>Discard</button>
              </div>
            ))}
            {kept.map((m) => (
              <div key={m.id} className="agent-card" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <Icon name="history" size={15} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {m.text}
                  <span className="muted" style={{ display: "block", fontSize: 12.5 }}>
                    {m.source === "agent" ? "Learned by Daedalus" : "Added by you"}
                    {m.project_id ? " · this project" : " · all projects"}
                  </span>
                </span>
                <button className="btn sm ghost" onClick={() => void decide(m.id, "dismissed")} aria-label={`Forget: ${m.text}`}>Forget</button>
              </div>
            ))}
            {proposed.length + kept.length === 0 && <p className="hint" style={{ margin: 0 }}>Nothing remembered yet.</p>}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", maxWidth: 820 }}>
          <label className="field" style={{ flex: 1, minWidth: 240 }}>
            <span>Add a memory</span>
            <input className="input" placeholder="Our customers are mostly on phones." value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          </label>
          <label className="field">
            <span>For</span>
            <select className="select" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value as "project" | "me" })}>
              <option value="project">This project</option>
              <option value="me">All my projects</option>
            </select>
          </label>
          <button className="btn" disabled={draft.text.trim().length < 3} onClick={() => void add()}>Add</button>
        </div>
      </section>
    </>
  );
}

function KitsSection({ projectId, onOpen }: { projectId: string; onOpen(s: Section): void }) {
  const [kits, setKits] = useState<Array<{ id: string; name: string; description: string; contents: string; installed: boolean }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<{ kits: Array<{ id: string; name: string; description: string; contents: string; installed: boolean }> }>(`/api/projects/${projectId}/kits`)
      .then((r) => !cancelled && setKits(r.kits))
      .catch(() => !cancelled && setKits([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, reload]);

  async function install(id: string, name: string) {
    setBusy(id);
    setNote(null);
    try {
      const r = await api<{ installed: string[] }>(`/api/projects/${projectId}/kits`, { method: "POST", json: { id } });
      setNote(`${name} installed${r.installed.length ? `: ${r.installed.join(", ")}` : ""}.`);
      setReload((n) => n + 1);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "Couldn't install the kit");
    } finally {
      setBusy(null);
    }
  }

  if (!kits) return <span className="spin" />;
  return (
    <section aria-labelledby="kits-h" className="agents-sec">
      <h2 id="kits-h" className="label">Kits</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        One install that adds connections, skills and rules together. Each part shows up in its own section afterwards, where you can change or remove it.
      </p>
      <div className="agent-cards">
        {kits.map((k) => (
          <article key={k.id} className="agent-card">
            <b>{k.name}</b>
            <span className="muted" style={{ fontSize: 13.5 }}>{k.description}</span>
            <span className="hint mono">{k.contents}</span>
            {k.installed ? (
              <span className="muted" style={{ fontSize: 13 }}>Installed</span>
            ) : (
              <button className="btn sm" style={{ justifySelf: "start" }} disabled={busy === k.id} onClick={() => void install(k.id, k.name)}>
                {busy === k.id && <span className="spin" />} Install
              </button>
            )}
          </article>
        ))}
      </div>
      {note && <p className="hint" role="status" style={{ margin: 0 }}>{note} <button className="btn sm ghost" onClick={() => onOpen("connections")}>See connections</button></p>}
    </section>
  );
}


type SuggestionRow = { id: string; kind: "skill" | "rule"; name: string; payload: Record<string, unknown>; evidence: string; status: string; created_at: string };

/**
 * Improve: Daedalus reads this project's recent runs and suggests skills, rules and memories,
 * each tied to something that happened. Suggestions from any turn are listed here too.
 */
function ImproveSection({ projectId, refreshKey, onReview, onChanged }: { projectId: string; refreshKey: number; onReview?(): void; onChanged?(): void }) {
  const [rows, setRows] = useState<SuggestionRow[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api<{ suggestions: SuggestionRow[] }>(`/api/projects/${projectId}/suggestions`)
      .then((r) => !cancelled && setRows(r.suggestions))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey, reload]);

  async function decide(id: string, status: "kept" | "dismissed") {
    setRows((r) => r?.map((x) => (x.id === id ? { ...x, status } : x)) ?? r);
    setErrors((e) => ({ ...e, [id]: "" }));
    await api(`/api/projects/${projectId}/suggestions`, { method: "PATCH", json: { id, status } })
      .then(() => onChanged?.())
      .catch((err) => {
        setErrors((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "Couldn't apply it" }));
        setReload((n) => n + 1);
      });
  }

  const pending = rows?.filter((r) => r.status === "proposed") ?? [];
  const added = rows?.filter((r) => r.status === "kept").slice(0, 10) ?? [];
  const view = (r: SuggestionRow) => ({ kind: r.kind, name: r.name, payload: r.payload, evidence: r.evidence }) as unknown as SuggestionData;

  return (
    <>
      <section aria-labelledby="improve-h" className="agents-sec">
        <h2 id="improve-h" className="label">Review recent runs</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14, maxWidth: 720 }}>
          Daedalus reads this project&apos;s recent runs (what was asked, every step, the automatic checks and what you said next), looks for problems that
          repeat, and suggests a skill, a rule or a memory for each, tied to the run that showed it. It changes nothing until you add a suggestion, and
          &ldquo;nothing to change&rdquo; is a valid answer. You can also type <span className="mono">/review</span> in the message box.
        </p>
        <div>
          <button className="btn primary" disabled={!onReview} onClick={() => onReview?.()} title={onReview ? undefined : "Wait for the current run to finish"}>
            <Icon name="loop" size={15} /> Review recent runs
          </button>
        </div>
      </section>

      <section aria-labelledby="sugg-h" className="agents-sec">
        <h2 id="sugg-h" className="label">Suggestions</h2>
        {rows === null ? (
          <span className="spin" />
        ) : pending.length + added.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>No suggestions yet. Daedalus suggests skills and rules while it works, and when you ask for a review.</p>
        ) : (
          <div style={{ display: "grid", gap: 8, maxWidth: 820 }}>
            {pending.map((r) => (
              <SuggestionView key={r.id} s={view(r)} status={r.status} error={errors[r.id]} onDecide={(st) => void decide(r.id, st)} />
            ))}
            {added.map((r) => (
              <SuggestionView key={r.id} s={view(r)} status="kept" />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
