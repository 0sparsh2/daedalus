/**
 * Builds the persisted assistant message from the agent's step results. The live UI gets
 * the same content as a stream; this is the durable copy written to Postgres when the run
 * ends, so a reload shows exactly what happened even after the workflow stream expires.
 * Pure and deterministic (runs in workflow context).
 */

export type PlainPart = { type: string; [key: string]: unknown };

type ContentLike = { type: string; [key: string]: unknown };

export function stepsToParts(steps: ReadonlyArray<{ content?: unknown }>): PlainPart[] {
  const parts: PlainPart[] = [];
  for (const step of steps) {
    parts.push({ type: "step-start" });
    const content = (Array.isArray(step.content) ? step.content : []) as ContentLike[];
    const results = new Map<string, ContentLike>();
    for (const c of content) {
      if ((c.type === "tool-result" || c.type === "tool-error") && typeof c.toolCallId === "string") results.set(c.toolCallId, c);
    }
    for (const c of content) {
      if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
        parts.push({ type: "text", text: c.text, state: "done" });
      } else if (c.type === "reasoning" && typeof c.text === "string" && c.text.trim()) {
        parts.push({ type: "reasoning", text: c.text, state: "done" });
      } else if (c.type === "tool-call") {
        const id = String(c.toolCallId);
        const r = results.get(id);
        const base = { type: `tool-${String(c.toolName)}`, toolCallId: id, input: c.input };
        if (r?.type === "tool-result") parts.push({ ...base, state: "output-available", output: plain(r.output) });
        else if (r?.type === "tool-error") parts.push({ ...base, state: "output-error", errorText: errorText(r.error) });
        else parts.push({ ...base, state: "output-error", errorText: "The run ended before this tool finished." });
      }
    }
  }
  return parts;
}

function plain(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "Tool failed";
  }
}
