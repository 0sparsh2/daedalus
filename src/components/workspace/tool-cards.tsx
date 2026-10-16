"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon, type IconName } from "@/components/icons";

export interface ToolPart {
  type: string;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error" | string;
  input?: Record<string, unknown>;
  output?: { ok?: boolean; text?: string; [key: string]: unknown };
  errorText?: string;
}

export interface SubagentData {
  kind: "research" | "explore";
  task: string;
  status: "running" | "done" | "error";
  model: string;
  steps: Array<{ tool: string; label: string; ok?: boolean }>;
  summary?: string;
}

const isDone = (p: ToolPart) => p.state === "output-available" || p.state === "output-error";
const failed = (p: ToolPart) => p.state === "output-error" || p.output?.ok === false;

function StatusIcon({ part }: { part: ToolPart }) {
  if (!isDone(part)) return <span className="spin" aria-label="Running" />;
  return failed(part) ? <Icon name="x" size={14} className="bad" label="Failed" /> : <Icon name="check" size={14} className="ok" label="Done" />;
}

export function Diff({ text }: { text: string }) {
  return (
    <pre className="codeblock diff">
      {text.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : l.startsWith("@@") ? "hunk" : undefined}>
          {l}
        </div>
      ))}
    </pre>
  );
}

function short(path: unknown) {
  return typeof path === "string" ? path : "";
}

/** One line per tool call, expandable to the details (diff, command output, check report). */
/** While the model is still writing a file, show the code arriving (the last lines, live). */
function LiveWrite({ part }: { part: ToolPart }) {
  const i = part.input ?? {};
  const path = typeof i.path === "string" ? i.path : "…";
  const text = typeof i.content === "string" ? i.content : typeof i.new_string === "string" ? i.new_string : "";
  const lines = text.split("\n");
  return (
    <div className="tool live-write" aria-live="off">
      <div className="tool-h">
        <span className="spin" aria-label="Writing" />
        <Icon name="pencil" size={14} className="faint" />
        <span className="t-title">
          {part.type === "tool-edit_file" ? "Editing" : "Writing"} <span className="mono">{path}</span>
        </span>
        <span className="t-meta mono">{lines.length} lines</span>
      </div>
      {text && <pre className="codeblock live">{lines.slice(-14).join("\n")}</pre>}
    </div>
  );
}

export function ToolCard({ part }: { part: ToolPart }) {
  const name = part.type.slice(5);
  if ((name === "write_file" || name === "edit_file") && (part.state === "input-streaming" || part.state === "input-available")) return <LiveWrite part={part} />;
  const i = part.input ?? {};
  const o = part.output ?? {};
  let icon: IconName = "bolt";
  let title: React.ReactNode = name;
  let meta: React.ReactNode = null;
  let body: React.ReactNode = null;

  switch (name) {
    case "write_file":
      icon = "pencil";
      title = (
        <>
          {o.created ? "Created" : isDone(part) ? "Wrote" : "Writing"} <span className="mono">{short(i.path)}</span>
        </>
      );
      if (isDone(part) && !failed(part)) meta = <span className="mono">+{String(o.added ?? 0)} −{String(o.removed ?? 0)}</span>;
      body = o.diff ? <Diff text={String(o.diff)} /> : typeof i.content === "string" ? <pre className="codeblock">{i.content.split("\n").slice(0, 60).join("\n")}</pre> : null;
      break;
    case "edit_file":
      icon = "pencil";
      title = (
        <>
          {isDone(part) ? "Edited" : "Editing"} <span className="mono">{short(i.path)}</span>
        </>
      );
      if (isDone(part) && !failed(part)) meta = <span className="mono">+{String(o.added ?? 0)} −{String(o.removed ?? 0)}</span>;
      body = o.diff ? <Diff text={String(o.diff)} /> : null;
      break;
    case "delete_file":
      icon = "trash";
      title = (
        <>
          Deleted <span className="mono">{short(i.path)}</span>
        </>
      );
      break;
    case "run_command":
      icon = "terminal";
      title = <span className="mono">{String(i.command ?? "")}</span>;
      if (isDone(part)) meta = o.timedOut ? "timed out" : `exit ${String(o.exitCode ?? "?")}`;
      body = o.text ? <pre className="codeblock">{String(o.text)}</pre> : null;
      break;
    case "dev_server":
      icon = "loop";
      title = `Dev server: ${String(i.action ?? "status")}`;
      body = o.text ? <pre className="codeblock">{String(o.text)}</pre> : null;
      break;
    case "verify":
      icon = "shield";
      title = isDone(part) ? (failed(part) ? "Type check or build failed" : "Type check and build passed") : "Type-checking and building";
      body = o.text ? <pre className="codeblock">{String(o.text)}</pre> : null;
      break;
    case "check_preview":
      icon = "eye";
      title = isDone(part) ? (failed(part) ? `Preview has ${String(o.problems ?? "")} problem${o.problems === 1 ? "" : "s"}` : "Preview is healthy") : "Checking the preview";
      if (isDone(part) && !failed(part) && o.modules) meta = `${String(o.modules)} modules`;
      body = o.text ? <pre className="codeblock">{String(o.text)}</pre> : null;
      break;
    case "update_todos": {
      const todos = (i.todos as Array<{ content: string; status: string }> | undefined) ?? [];
      return <TodoList todos={todos} />;
    }
    default:
      title = name.replace(/_/g, " ");
      body = o.text ? <pre className="codeblock">{String(o.text)}</pre> : null;
  }

  if (part.state === "output-error") body = <pre className="codeblock">{part.errorText}</pre>;
  else if (failed(part) && o.text && !body) body = <pre className="codeblock">{String(o.text)}</pre>;

  return (
    <details className="tool" open={failed(part) && name !== "run_command" ? undefined : undefined}>
      <summary>
        <StatusIcon part={part} />
        <Icon name={icon} size={14} className="faint" />
        <span className="t-title">{title}</span>
        {meta && <span className="t-meta">{meta}</span>}
      </summary>
      {body && <div className="t-body">{body}</div>}
    </details>
  );
}

export function ExploreGroup({ parts }: { parts: ToolPart[] }) {
  const running = parts.some((p) => !isDone(p));
  const files = parts.filter((p) => p.type === "tool-read_file").length;
  const searches = parts.filter((p) => p.type === "tool-grep" || p.type === "tool-glob").length;
  const label = [files ? `read ${files} file${files === 1 ? "" : "s"}` : "", searches ? `${searches} search${searches === 1 ? "" : "es"}` : "", parts.some((p) => p.type === "tool-list_files") ? "listed files" : ""]
    .filter(Boolean)
    .join(", ");
  return (
    <details className="tool">
      <summary>
        {running ? <span className="spin" /> : <Icon name="search" size={14} className="faint" />}
        <span className="t-title">{running ? "Exploring the project" : `Explored: ${label}`}</span>
      </summary>
      <div className="t-body">
        <ul className="todos">
          {parts.map((p) => (
            <li key={p.toolCallId}>
              <StatusIcon part={p} />
              <span className="mono" style={{ fontSize: 12.5 }}>
                {p.type.slice(5)} {String(p.input?.path ?? p.input?.pattern ?? "")}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

export function TodoList({ todos }: { todos: Array<{ content: string; status: string }> }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  return (
    <div className="tool" style={{ padding: "8px 10px", display: "grid", gap: 6 }}>
      <div className="label" style={{ display: "flex", gap: 8 }}>
        Task list <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>{done}/{todos.length} done</span>
      </div>
      <ul className="todos">
        {todos.map((t, idx) => (
          <li key={idx} className={t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}>
            {t.status === "completed" ? <Icon name="check" size={14} className="ok" /> : t.status === "in_progress" ? <span className="spin" /> : <Icon name="dot" size={14} className="faint" />}
            {t.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SubagentCard({ part, live, onOpenTrace }: { part: ToolPart; live?: SubagentData; onOpenTrace(): void }) {
  const kind = part.type === "tool-research" ? "Research" : "Explore";
  const done = isDone(part);
  const steps = live?.steps ?? [];
  const summary = done ? (part.output?.text ?? part.errorText) : live?.summary;
  return (
    <div className="subagent">
      <div className="sa-h">
        {done ? (failed(part) ? <Icon name="x" size={14} className="bad" /> : <Icon name="agents" size={14} />) : <span className="spin" />}
        <b>{kind} sub-agent</b>
        <span className="muted" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {String(part.input?.task ?? live?.task ?? "")}
        </span>
        <button className="btn ghost sm" onClick={onOpenTrace}>
          <Icon name="flow" size={13} /> Trace
        </button>
      </div>
      {steps.length > 0 && (
        <ul className="sa-steps">
          {steps.map((s, i) => (
            <li key={i}>
              {s.ok === undefined ? "…" : s.ok ? "✓" : "✗"} {s.label}
            </li>
          ))}
        </ul>
      )}
      {summary && (
        <details className="sa-sum">
          <summary style={{ cursor: "pointer", fontSize: 13 }} className="muted">
            Findings{live?.model ? ` · ${live.model}` : ""}
          </summary>
          <div className="prose" style={{ marginTop: 6 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(summary)}</ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  );
}

export function PlanCard({ part, canBuild, onStartBuild, onRequestChanges }: { part: ToolPart; canBuild: boolean; onStartBuild(): void; onRequestChanges(): void }) {
  const p = (part.input ?? {}) as {
    title?: string;
    summary?: string;
    features?: string[];
    design?: string;
    steps?: string[];
    assumptions?: string[];
    questions?: string[];
  };
  if (!isDone(part) && !p.title) {
    return (
      <div className="status-line">
        <span className="spin" /> Writing the plan…
      </div>
    );
  }
  return (
    <section className="plan-card" aria-label="Proposed plan">
      <div className="label">Plan ready</div>
      <h2 className="plan-title">{p.title}</h2>
      {p.summary && <p style={{ margin: 0 }}>{p.summary}</p>}
      {p.features?.length ? (
        <div>
          <div className="label" style={{ marginBottom: 4 }}>What you&apos;ll get</div>
          <ul>{p.features.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      ) : null}
      {p.design && (
        <div>
          <div className="label" style={{ marginBottom: 4 }}>Look and feel</div>
          <p style={{ margin: 0, fontSize: 14 }}>{p.design}</p>
        </div>
      )}
      {p.steps?.length ? (
        <div>
          <div className="label" style={{ marginBottom: 4 }}>How I&apos;ll build it</div>
          <ol>{p.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
        </div>
      ) : null}
      {p.assumptions?.length ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>Assumptions: {p.assumptions.join("; ")}</p> : null}
      {p.questions?.length ? (
        <div className="banner info">
          <Icon name="info" />
          <div>
            <b>Questions for you</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{p.questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
          </div>
        </div>
      ) : null}
      {canBuild && (
        <div className="plan-actions">
          <button className="btn primary" onClick={onStartBuild}>
            <Icon name="bolt" /> Start building
          </button>
          <button className="btn" onClick={onRequestChanges}>
            Suggest changes
          </button>
        </div>
      )}
    </section>
  );
}

export function CheckLine({ data }: { data: { round: number; status: string; problems?: number } }) {
  if (data.status === "running") {
    return (
      <div className="check-line">
        <span className="spin" /> Automatic check: type check, build and preview…
      </div>
    );
  }
  const ok = data.status === "passed";
  return (
    <div className={`check-line ${ok ? "passed" : "failed"}`}>
      <Icon name={ok ? "shield" : "alert"} size={14} />
      {ok ? "Automatic check passed: it compiles, builds and renders." : `Automatic check found ${data.problems ?? "some"} problem${data.problems === 1 ? "" : "s"}; Daedalus is fixing ${data.problems === 1 ? "it" : "them"}.`}
    </div>
  );
}

export function CheckpointLine({ data }: { data: { sha: string; message: string; files: number } }) {
  return (
    <div className="checkpoint-line">
      <Icon name="history" size={14} /> Saved version <span className="mono">{data.sha.slice(0, 7)}</span> · {data.files} file{data.files === 1 ? "" : "s"} changed
    </div>
  );
}
