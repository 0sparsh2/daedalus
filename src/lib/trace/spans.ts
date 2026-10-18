import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { isSecretKey, redactText } from "@/lib/redact";

export type SpanKind = "run" | "llm" | "tool" | "subagent" | "sandbox" | "verify" | "system";
export type SpanStatus = "running" | "ok" | "error" | "cancelled";

export interface SpanScope {
  runId: string;
  projectId: string;
  userId: string;
}

export interface SpanStartInput extends SpanScope {
  id?: string;
  parentId?: string | null;
  kind: SpanKind;
  name: string;
  attrs?: Record<string, unknown>;
  input?: unknown;
  startedAt?: Date;
}

const MAX_STRING = 4_000;
const MAX_ITEMS = 60;

/**
 * Keeps span payloads small and free of secrets: long strings, arrays and deep objects are
 * trimmed, and keys or tokens are masked (lib/redact.ts) before anything is trimmed, so a key cut
 * at the limit can't slip through half-matched.
 */
export function clip(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    const s = redactText(value);
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… [${s.length - MAX_STRING} more chars]` : s;
  }
  if (typeof value !== "object") return value;
  if (depth > 5) return "[…]";
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => clip(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `[${value.length - MAX_ITEMS} more]`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = typeof v === "string" && v.length >= 6 && isSecretKey(k) ? "[REDACTED]" : clip(v, depth + 1);
  return out;
}

export async function startSpan(s: SpanStartInput): Promise<string> {
  const id = s.id ?? randomUUID();
  const { error } = await supabaseAdmin()
    .from("spans")
    .insert({
      id,
      run_id: s.runId,
      project_id: s.projectId,
      user_id: s.userId,
      parent_id: s.parentId ?? null,
      kind: s.kind,
      name: s.name,
      status: "running",
      started_at: (s.startedAt ?? new Date()).toISOString(),
      attrs: clip(s.attrs ?? {}),
      input: clip(s.input ?? null),
    });
  if (error) console.error("[trace] startSpan failed", error.message);
  return id;
}

export async function endSpan(
  id: string,
  end: { status: SpanStatus; output?: unknown; error?: string; attrs?: Record<string, unknown>; startedAt?: Date },
) {
  const endedAt = new Date();
  const patch: Record<string, unknown> = {
    status: end.status,
    ended_at: endedAt.toISOString(),
    output: clip(end.output ?? null),
    error: end.error ? redactText(end.error).slice(0, MAX_STRING) : null,
  };
  if (end.startedAt) patch.duration_ms = endedAt.getTime() - end.startedAt.getTime();
  if (end.attrs) {
    const { data } = await supabaseAdmin().from("spans").select("attrs,started_at").eq("id", id).maybeSingle();
    patch.attrs = clip({ ...(data?.attrs ?? {}), ...end.attrs });
    if (!end.startedAt && data?.started_at) patch.duration_ms = endedAt.getTime() - new Date(data.started_at).getTime();
  } else if (!end.startedAt) {
    const { data } = await supabaseAdmin().from("spans").select("started_at").eq("id", id).maybeSingle();
    if (data?.started_at) patch.duration_ms = endedAt.getTime() - new Date(data.started_at).getTime();
  }
  const { error } = await supabaseAdmin().from("spans").update(patch).eq("id", id);
  if (error) console.error("[trace] endSpan failed", error.message);
}

/** Writes a finished span in one call (used by the gateway, which knows start and end). */
export async function recordSpan(
  s: SpanStartInput & { status: SpanStatus; endedAt: Date; output?: unknown; error?: string },
) {
  const startedAt = s.startedAt ?? s.endedAt;
  const { error } = await supabaseAdmin()
    .from("spans")
    .insert({
      id: s.id ?? randomUUID(),
      run_id: s.runId,
      project_id: s.projectId,
      user_id: s.userId,
      parent_id: s.parentId ?? null,
      kind: s.kind,
      name: s.name,
      status: s.status,
      started_at: startedAt.toISOString(),
      ended_at: s.endedAt.toISOString(),
      duration_ms: s.endedAt.getTime() - startedAt.getTime(),
      attrs: clip(s.attrs ?? {}),
      input: clip(s.input ?? null),
      output: clip(s.output ?? null),
      error: s.error ? redactText(s.error).slice(0, MAX_STRING) : null,
    });
  if (error) console.error("[trace] recordSpan failed", error.message);
}

export async function addRunUsage(runId: string, usage: { input?: number; output?: number; llmCalls?: number; toolCalls?: number }) {
  const { error } = await supabaseAdmin().rpc("add_run_usage", {
    p_run_id: runId,
    p_input: usage.input ?? 0,
    p_output: usage.output ?? 0,
    p_llm_calls: usage.llmCalls ?? 0,
    p_tool_calls: usage.toolCalls ?? 0,
  });
  if (error) console.error("[trace] addRunUsage failed", error.message);
}
