import "server-only";
import { createHash } from "node:crypto";
import { getStepMetadata } from "workflow";
import { attachProjectSandbox, type SandboxHandle } from "@/lib/sandbox";
import { addRunUsage, endSpan, startSpan, type SpanKind } from "@/lib/trace/spans";
import type { RunScope, ToolOutput } from "./scope";

/** An expected failure the model should read and react to (bad path, edit miss, …). */
export class ToolError extends Error {}

/** Deterministic UUID from parts, so a retried step updates the same span instead of adding one. */
export function stableId(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const TRANSIENT = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|50[234]|429|rate limit|temporar/i;

/**
 * Wraps one tool call: opens a trace span, attaches the project sandbox, runs the tool, and
 * turns failures into results the model can act on. Transient infrastructure errors are
 * rethrown on the first attempts so the durable step retries them; everything else becomes
 * `{ ok: false, text: "Error: …" }` so a bad tool call never kills the run.
 */
export async function runTool<T extends ToolOutput>(
  name: string,
  input: unknown,
  ctx: { toolCallId: string; scope: RunScope },
  fn: (sandbox: SandboxHandle) => Promise<T>,
  opts: { kind?: SpanKind; sandbox?: boolean } = {},
): Promise<T | ToolOutput> {
  const { scope, toolCallId } = ctx;
  const spanId = stableId(scope.runId, toolCallId);
  const startedAt = new Date();
  let attempt = 1;
  try {
    attempt = getStepMetadata().attempt ?? 1;
  } catch {
    // Not inside a durable step (tests, sub-agents): single attempt.
  }
  await startSpan({
    id: spanId,
    runId: scope.runId,
    projectId: scope.projectId,
    userId: scope.userId,
    parentId: scope.runId,
    kind: opts.kind ?? "tool",
    name,
    input,
    attrs: { toolCallId, attempt },
  }).catch(() => {});
  try {
    const sandbox = opts.sandbox === false ? (undefined as unknown as SandboxHandle) : await attachProjectSandbox(scope.projectId);
    const result = await fn(sandbox);
    await Promise.all([
      endSpan(spanId, { status: result.ok ? "ok" : "error", output: summarize(result), error: result.ok ? undefined : result.text, startedAt }),
      addRunUsage(scope.runId, { toolCalls: 1 }),
    ]);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ToolError) && TRANSIENT.test(message) && attempt < 3) {
      throw err; // let the durable step retry with backoff
    }
    await Promise.all([
      endSpan(spanId, { status: "error", error: message, startedAt }),
      addRunUsage(scope.runId, { toolCalls: 1 }),
    ]);
    return { ok: false, text: `Error: ${message}` };
  }
}

function summarize(out: ToolOutput) {
  const { text, ...rest } = out;
  return { text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text, ...rest };
}

/** Keeps the head and tail of long output, which is where errors and summaries live. */
/**
 * An error with what's needed to debug it from the trace: the message, the cause, and the
 * start of the response body for API errors ("Invalid JSON response" says nothing on its own).
 */
export function errorDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { cause?: unknown; responseBody?: string; statusCode?: number };
  const cause = e.cause instanceof Error ? e.cause.message : e.cause != null ? String(e.cause) : "";
  return [
    e.message,
    e.statusCode ? `HTTP ${e.statusCode}` : "",
    cause ? `cause: ${cause.slice(0, 600)}` : "",
    e.responseBody ? `response: ${e.responseBody.slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function truncateMiddle(s: string, max = 12_000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n… [${s.length - max} characters omitted] …\n\n${s.slice(-tail)}`;
}
