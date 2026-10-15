"use client";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icons";
import { api, timeAgo } from "@/lib/client/api";

interface Run {
  id: string;
  mode: string;
  provider: string;
  model: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  input_tokens: number;
  output_tokens: number;
  llm_calls: number;
  tool_calls: number;
  error?: string | null;
}

interface Span {
  id: string;
  parent_id: string | null;
  kind: string;
  name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  attrs: Record<string, unknown>;
  input: unknown;
  output: unknown;
  error: string | null;
}

/**
 * The run's trace: every model call, tool call, sub-agent and check, as a tree with a
 * timeline. Model calls are recorded by the LLM gateway; tools by their durable steps;
 * sub-agent calls nest under the sub-agent's span.
 */
export function TracePanel({ projectId, runId, onSelectRun, live }: { projectId: string; runId: string | null; onSelectRun(id: string): void; live: boolean }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [data, setData] = useState<{ run: Run; spans: Span[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api<{ runs: Run[] }>(`/api/runs?projectId=${projectId}`)
      .then((r) => {
        setRuns(r.runs);
        if (!runId && r.runs[0]) onSelectRun(r.runs[0].id);
      })
      .catch(() => {});
  }, [projectId, runId, live, onSelectRun]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api<{ run: Run; spans: Span[] }>(`/api/runs/${runId}/spans`);
        if (cancelled) return;
        setData(r);
        setNow(Date.now());
        if (r.run.status === "running" || r.run.status === "queued") timer = setTimeout(load, 1500);
      } catch {
        if (!cancelled) timer = setTimeout(load, 4000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, live]);

  const rows = useMemo(() => {
    if (!data) return [];
    const children = new Map<string, Span[]>();
    for (const s of data.spans) {
      if (!s.parent_id || s.parent_id === s.id) continue;
      children.set(s.parent_id, [...(children.get(s.parent_id) ?? []), s]);
    }
    const out: Array<{ span: Span; depth: number }> = [];
    const visit = (s: Span, depth: number) => {
      out.push({ span: s, depth });
      for (const c of (children.get(s.id) ?? []).sort((a, b) => a.started_at.localeCompare(b.started_at))) visit(c, depth + 1);
    };
    const roots = data.spans.filter((s) => !s.parent_id || s.parent_id === s.id || !data.spans.some((p) => p.id === s.parent_id));
    for (const r of roots.sort((a, b) => a.started_at.localeCompare(b.started_at))) visit(r, 0);
    return out;
  }, [data]);

  if (!runId && runs.length === 0) {
    return (
      <div className="empty">
        <Icon name="flow" size={22} />
        <b>No runs yet</b>
        <span>Every run is traced: model calls, tool calls, sub-agents and checks, with timings and tokens.</span>
      </div>
    );
  }

  const run = data?.run;
  const t0 = run ? new Date(run.started_at).getTime() : 0;
  const t1 = run ? Math.max(...(data?.spans ?? []).map((s) => (s.ended_at ? new Date(s.ended_at).getTime() : now)), run.ended_at ? new Date(run.ended_at).getTime() : now, t0 + 1) : 1;
  const total = t1 - t0;
  const sel = data?.spans.find((s) => s.id === selected) ?? null;
  const subagents = data?.spans.filter((s) => s.kind === "subagent").length ?? 0;

  return (
    <div className="trace">
      <div className="trace-head">
        <label className="sr-only" htmlFor="run-select">Run</label>
        <select id="run-select" className="select" value={runId ?? ""} onChange={(e) => onSelectRun(e.target.value)}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.mode === "plan" ? "Plan" : "Build"} · {timeAgo(r.started_at)} · {r.status}
            </option>
          ))}
        </select>
        {run && (
          <div className="metrics">
            <span>
              <b>{fmtMs(total)}</b> total
            </span>
            <span>
              <b>{run.llm_calls}</b> model calls
            </span>
            <span>
              <b>{run.tool_calls}</b> tool calls
            </span>
            {subagents > 0 && (
              <span>
                <b>{subagents}</b> sub-agent{subagents === 1 ? "" : "s"}
              </span>
            )}
            <span>
              <b>{fmtTokens(run.input_tokens)}</b> in / <b>{fmtTokens(run.output_tokens)}</b> out
            </span>
            <span className="mono">{run.model}</span>
            <span className={`pill ${run.status === "succeeded" ? "ok" : run.status === "failed" ? "bad" : run.status === "cancelled" ? "warn" : "live"}`}>{run.status}</span>
          </div>
        )}
      </div>
      <div className="trace-body">
        <div className="spans" role="listbox" aria-label="Spans">
          {rows.map(({ span, depth }) => {
            const s = new Date(span.started_at).getTime();
            const e = span.ended_at ? new Date(span.ended_at).getTime() : now;
            const left = ((s - t0) / total) * 100;
            const width = Math.max(((e - s) / total) * 100, 0.4);
            return (
              <button key={span.id} className="span-row" role="option" aria-selected={selected === span.id} onClick={() => setSelected(span.id)}>
                <span className="span-name" style={{ paddingLeft: depth * 14 }}>
                  <span className={`kind ${span.kind}`}>{span.kind}</span>
                  <span className="nm" title={span.name}>
                    {span.name}
                  </span>
                  {span.status === "error" && <Icon name="alert" size={12} className="bad" />}
                </span>
                <span className="bar-track" aria-hidden="true">
                  <span className={`bar ${span.kind} ${span.status === "error" ? "error" : ""} ${span.status === "running" ? "running" : ""}`} style={{ left: `${left}%`, width: `${width}%` }} />
                </span>
                <span className="dur">{span.status === "running" ? "…" : fmtMs(span.duration_ms ?? e - s)}</span>
              </button>
            );
          })}
        </div>
        <aside className="span-detail" aria-label="Span details">
          {sel ? <SpanDetail span={sel} /> : <p className="muted" style={{ margin: 0 }}>Select a span to see its inputs, outputs, timing and tokens.</p>}
        </aside>
      </div>
    </div>
  );
}

function SpanDetail({ span }: { span: Span }) {
  const a = span.attrs ?? {};
  const facts: Array<[string, unknown]> = [
    ["kind", span.kind],
    ["status", span.status],
    ["duration", span.duration_ms != null ? fmtMs(span.duration_ms) : "running"],
    ["started", new Date(span.started_at).toLocaleTimeString()],
    ...Object.entries(a).filter(([, v]) => v !== undefined && v !== null && typeof v !== "object"),
  ];
  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className={`kind ${span.kind}`}>{span.kind}</span>
        <b style={{ overflowWrap: "anywhere" }}>{span.name}</b>
      </div>
      <dl className="kv">
        {facts.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
      </dl>
      {span.error && <div className="error-text">{span.error}</div>}
      {span.input != null && (
        <div>
          <div className="label">Input</div>
          <pre className="codeblock">{pretty(span.input)}</pre>
        </div>
      )}
      {span.output != null && (
        <div>
          <div className="label">Output</div>
          <pre className="codeblock">{pretty(span.output)}</pre>
        </div>
      )}
    </>
  );
}

function pretty(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function fmtMs(ms: number) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
