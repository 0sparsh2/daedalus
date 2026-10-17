"use client";
import type { UIMessage } from "ai";
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@/components/icons";
import { PartBoundary } from "./part-boundary";
import { CheckLine, CheckpointLine, PlanCard, QuestionsCard, RouteChip, SubagentCard, ToolCard, ExploreGroup, type ToolPart, type SubagentData } from "./tool-cards";

type Part = UIMessage["parts"][number] & { type: string; [key: string]: unknown };

const READ_ONLY = new Set(["list_files", "read_file", "glob", "grep"]);

export function Messages({
  messages,
  status,
  onStartBuild,
  onAnswer,
  onRequestChanges,
  onOpenTrace,
}: {
  messages: UIMessage[];
  status: string;
  onStartBuild(): void;
  onAnswer(text: string): void;
  onRequestChanges(): void;
  onOpenTrace(runId?: string): void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = document.getElementById("chat-scroll");
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="empty" style={{ height: "auto", paddingTop: 48 }}>
        <Icon name="sparkle" size={22} />
        <b>Describe your app to get started</b>
        <span style={{ maxWidth: 320, fontSize: 14 }}>Plan first to agree on what to build, or switch to Build to start right away.</span>
      </div>
    );
  }

  const live = status === "submitted" || status === "streaming";
  return (
    <>
      {messages.map((m, i) =>
        m.role === "user" ? (
          <div key={m.id} className="msg-user">
            {(m.parts as Part[]).filter((p) => p.type === "text").map((p) => String(p.text)).join("\n")}
          </div>
        ) : (
          <AssistantMessage
            key={m.id}
            message={m}
            live={live && i === messages.length - 1}
            onStartBuild={onStartBuild}
            onRequestChanges={onRequestChanges}
            onAnswer={onAnswer}
            onOpenTrace={onOpenTrace}
            isLatest={i === messages.length - 1}
          />
        ),
      )}
      {status === "submitted" && messages[messages.length - 1]?.role === "user" && (
        <div className="status-line" role="status">
          <span className="spin" /> Starting…
        </div>
      )}
      <div ref={end} />
    </>
  );
}

function AssistantMessage({
  message,
  live,
  isLatest,
  onStartBuild,
  onAnswer,
  onRequestChanges,
  onOpenTrace,
}: {
  message: UIMessage;
  live: boolean;
  isLatest: boolean;
  onStartBuild(): void;
  onAnswer(text: string): void;
  onRequestChanges(): void;
  onOpenTrace(runId?: string): void;
}) {
  const parts = message.parts as Part[];
  const runId = (message.metadata as { runId?: string } | undefined)?.runId;
  const subagents = new Map<string, SubagentData>();
  for (const p of parts) if (p.type === "data-subagent" && typeof p.id === "string") subagents.set(p.id, p.data as SubagentData);
  const status = [...parts].reverse().find((p) => p.type === "data-status")?.data as { stage: string; note: string } | undefined;
  const route = (message.metadata as { route?: { route: string; by: string; reason: string } } | undefined)?.route;

  // Group consecutive read-only tool calls into one "Explored" line.
  const blocks: Array<{ kind: "part"; part: Part; key: string } | { kind: "explore"; parts: ToolPart[]; key: string }> = [];
  parts.forEach((p, idx) => {
    const name = p.type.startsWith("tool-") ? p.type.slice(5) : null;
    if (name && READ_ONLY.has(name)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "explore") last.parts.push(p as unknown as ToolPart);
      else blocks.push({ kind: "explore", parts: [p as unknown as ToolPart], key: `e${idx}` });
    } else blocks.push({ kind: "part", part: p, key: `p${idx}` });
  });

  const busyTool = live && parts.length > 0 && parts[parts.length - 1].type.startsWith("tool-") && (parts[parts.length - 1] as { state?: string }).state !== "output-available" && (parts[parts.length - 1] as { state?: string }).state !== "output-error";

  const renderBlock = (b: (typeof blocks)[number]) => {
    if (b.kind === "explore") return <ExploreGroup key={b.key} parts={b.parts} />;
    const p = b.part;
    if (p.type === "text") {
      return (
        <div key={b.key} className="prose">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{String(p.text ?? "")}</ReactMarkdown>
        </div>
      );
    }
    if (p.type === "reasoning") {
      const text = String(p.text ?? "").trim();
      if (!text) return null;
      return (
        <details key={b.key} className="thinking">
          <summary>
            <Icon name="sparkle" size={13} /> Thinking
          </summary>
          <div className="think-body">{text}</div>
        </details>
      );
    }
    if (p.type === "tool-ask_user") {
      return <QuestionsCard key={b.key} part={p as unknown as ToolPart} canAnswer={isLatest && !live} onAnswer={onAnswer} />;
    }
    if (p.type === "tool-propose_plan") {
      return <PlanCard key={b.key} part={p as unknown as ToolPart} canBuild={isLatest && !live} onStartBuild={onStartBuild} onRequestChanges={onRequestChanges} />;
    }
    if (p.type === "tool-research" || p.type === "tool-explore") {
      const tp = p as unknown as ToolPart;
      return <SubagentCard key={b.key} part={tp} live={subagents.get(tp.toolCallId)} onOpenTrace={() => onOpenTrace(runId)} />;
    }
    if (p.type.startsWith("tool-")) return <ToolCard key={b.key} part={p as unknown as ToolPart} />;
    if (p.type === "data-check") return <CheckLine key={b.key} data={p.data as never} />;
    if (p.type === "data-checkpoint") return <CheckpointLine key={b.key} data={p.data as never} />;
    if (p.type === "data-run-end") {
      const d = p.data as { outcome: string; note: string };
      return (
        <div key={b.key} className={`banner ${d.outcome === "cancelled" ? "info" : "error"}`}>
          <Icon name={d.outcome === "cancelled" ? "info" : "alert"} /> {d.note}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="msg-ai">
      <div className="who">
        <span className="brand-mark" style={{ width: 16, height: 16 }} aria-hidden="true" /> Daedalus
        {route && <RouteChip data={route} />}
        {runId && (
          <button className="btn ghost sm" style={{ marginLeft: "auto" }} onClick={() => onOpenTrace(runId)} title="See every model call and tool call in this run">
            <Icon name="flow" size={13} /> Trace
          </button>
        )}
      </div>
      {live && status && status.stage !== "ready" && (
        <div className="status-line" role="status">
          <span className="spin" /> {status.note}…
        </div>
      )}
      {blocks.map((b) => (
        <PartBoundary key={b.key}>{renderBlock(b)}</PartBoundary>
      ))}
      {live && (busyTool || parts.length === 0 || parts[parts.length - 1]?.type === "step-start" || parts[parts.length - 1]?.type?.startsWith("data-")) && (
        <div className="status-line" role="status" aria-live="polite">
          <span className="spin" /> Working…
        </div>
      )}
    </div>
  );
}
