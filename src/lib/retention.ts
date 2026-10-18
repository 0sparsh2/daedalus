import "server-only";
import { supabaseAdmin } from "./supabase/admin";

/**
 * Trace retention. Spans are most of the database: every model call and tool call is one. After
 * `TRACE_RETENTION_DAYS` (default 30, never under 2) a span keeps its row, so the Trace tab still
 * shows what ran, how long it took and what it cost, but its input and output are cleared.
 * Messages and versions are the user's work and are never deleted here.
 */

const BATCH = 500;
/** Batches per invocation: enough for a day's traffic, small enough to finish inside a function's time limit. */
const MAX_BATCHES = 40;

export function retentionDays(): number {
  const n = Number(process.env.TRACE_RETENTION_DAYS ?? 30);
  return Number.isFinite(n) ? Math.max(2, Math.floor(n)) : 30;
}

export async function pruneTraces(now = new Date()): Promise<{ cleared: number; cutoff: string; done: boolean }> {
  const cutoff = new Date(now.getTime() - retentionDays() * 24 * 60 * 60 * 1000).toISOString();
  let cleared = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { data, error } = await supabaseAdmin().rpc("prune_span_details", { p_cutoff: cutoff, p_limit: BATCH });
    if (error) throw new Error(error.message);
    const n = Number(data ?? 0);
    cleared += n;
    if (n < BATCH) return { cleared, cutoff, done: true };
  }
  return { cleared, cutoff, done: false };
}
