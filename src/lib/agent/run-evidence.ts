import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { truncateMiddle } from "./runtime";

/**
 * What a review turn reads: the project's past runs. The prompt gets a short index and the
 * reviewer reads whole runs on demand with read_run, the way Harness² (Google Research,
 * Apache-2.0) serves evidence as files behind a short pointer instead of squeezing it into a
 * prompt. Errors and check failures are kept close to whole: cutting them short is how a
 * reviewer ends up "finding" problems that weren't there.
 */

type Part = { type: string; text?: string; input?: unknown; output?: unknown; state?: string; errorText?: string; data?: Record<string, unknown> };

export interface RunIndexEntry {
  id: string;
  when: string;
  route: string;
  status: string;
  request: string;
  toolErrors: number;
  failedChecks: number;
  /** The user's next message, when it came after this run (corrections show up here). */
  followedBy?: string;
}

const textOf = (parts: unknown) =>
  (Array.isArray(parts) ? (parts as Part[]) : [])
    .filter((p) => p.type === "text")
    .map((p) => String(p.text ?? ""))
    .join(" ")
    .trim();

/** The project's newest 400 messages, oldest first (a long project's early chat isn't needed). */
async function recentMessages(projectId: string) {
  const { data } = await supabaseAdmin().from("messages").select("id,role,parts,metadata,created_at").eq("project_id", projectId).order("created_at", { ascending: false }).limit(400);
  return (data ?? []).reverse();
}

/** The project's recent finished runs, newest first, without review turns. */
export async function recentRunsIndex(projectId: string, currentRunId: string, limit = 12): Promise<RunIndexEntry[]> {
  const db = supabaseAdmin();
  const { data: runs } = await db
    .from("runs")
    .select("id,route,mode,status,error,started_at")
    .eq("project_id", projectId)
    .neq("id", currentRunId)
    .in("status", ["succeeded", "failed", "cancelled"])
    .order("started_at", { ascending: false })
    .limit(limit + 10);
  const kept = (runs ?? []).filter((r) => r.route !== "review").slice(0, limit);
  if (!kept.length) return [];
  const all = await recentMessages(projectId);
  return kept.map((r) => {
    const userIdx = all.findIndex((m) => m.role === "user" && (m.metadata as { runId?: string } | null)?.runId === r.id);
    const assistant = all.find((m) => m.id === `a-${r.id}`);
    const parts = (assistant?.parts ?? []) as Part[];
    const next = userIdx >= 0 ? all.slice(userIdx + 1).find((m) => m.role === "user") : undefined;
    return {
      id: r.id,
      when: String(r.started_at).slice(0, 16).replace("T", " "),
      route: r.route ?? r.mode,
      status: r.status,
      request: textOf(all[userIdx]?.parts).slice(0, 160),
      toolErrors: parts.filter((p) => p.type.startsWith("tool-") && (p.state === "output-error" || (p.output as { ok?: boolean } | undefined)?.ok === false)).length,
      failedChecks: parts.filter((p) => p.type === "data-check" && p.data?.status === "failed").length,
      followedBy: next ? textOf(next.parts).slice(0, 160) : undefined,
    };
  });
}

export function runsIndexText(entries: RunIndexEntry[]): string {
  if (!entries.length) return "(no finished runs yet)";
  return entries
    .map((e) => {
      const flags = [e.status !== "succeeded" ? e.status : "", e.toolErrors ? `${e.toolErrors} tool error${e.toolErrors === 1 ? "" : "s"}` : "", e.failedChecks ? `${e.failedChecks} failed check${e.failedChecks === 1 ? "" : "s"}` : ""].filter(Boolean);
      return `- ${e.id} · ${e.when} · ${e.route}${flags.length ? ` · ${flags.join(", ")}` : ""}\n  asked: “${e.request}”${e.followedBy ? `\n  user's next message: “${e.followedBy}”` : ""}`;
    })
    .join("\n");
}

const BUDGET = 48_000;

/** One run, as a readable transcript: the request, every step, check results, and what the user said next. */
export async function runTranscript(projectId: string, runId: string): Promise<string | null> {
  const db = supabaseAdmin();
  const { data: run } = await db.from("runs").select("id,project_id,route,mode,status,error,started_at,summary").eq("id", runId).maybeSingle();
  if (!run || run.project_id !== projectId) return null;
  const [all, { data: checks }] = await Promise.all([
    recentMessages(projectId),
    db.from("spans").select("name,status,output").eq("run_id", runId).eq("kind", "verify").order("started_at", { ascending: true }),
  ]);
  const userIdx = all.findIndex((m) => m.role === "user" && (m.metadata as { runId?: string } | null)?.runId === runId);
  const assistant = all.find((m) => m.id === `a-${runId}`);
  const next = userIdx >= 0 ? all.slice(userIdx + 1).find((m) => m.role === "user") : undefined;

  const out: string[] = [
    `Run ${run.id} · ${String(run.started_at).slice(0, 16).replace("T", " ")} · ${run.route ?? run.mode} · ${run.status}${run.error ? ` · error: ${truncateMiddle(run.error, 1500)}` : ""}`,
    `\n## The user asked\n${truncateMiddle(textOf(all[userIdx]?.parts) || "(not found)", 4000)}`,
    "\n## What happened",
  ];
  const checkSpans = (checks ?? []) as Array<{ name: string; status: string; output: Record<string, unknown> | null }>;
  for (const p of (assistant?.parts ?? []) as Part[]) {
    if (p.type === "text" && p.text?.trim()) out.push(`Daedalus: ${truncateMiddle(p.text.trim(), 2500)}`);
    else if (p.type.startsWith("tool-")) {
      const name = p.type.slice(5);
      const input = truncateMiddle(JSON.stringify(p.input ?? {}), 400);
      const o = p.output as { ok?: boolean; text?: string } | undefined;
      if (p.state === "output-error") out.push(`→ ${name} ${input}\n  ERROR: ${truncateMiddle(p.errorText ?? "", 2500)}`);
      else if (o?.ok === false) out.push(`→ ${name} ${input}\n  FAILED: ${truncateMiddle(o.text ?? "", 2500)}`);
      else out.push(`→ ${name} ${input}\n  ok: ${truncateMiddle(o?.text ?? "", 900)}`);
    } else if (p.type === "data-check") {
      const round = Number(p.data?.round ?? 0);
      const span = checkSpans.find((s) => s.name === `Automatic check #${round + 1}`);
      const detail = span && span.status === "error" && span.output ? `\n  ${truncateMiddle(JSON.stringify(span.output), 3000)}` : "";
      out.push(`[automatic check #${round + 1}: ${p.data?.status}${p.data?.problems ? `, ${p.data.problems} problem(s)` : ""}]${detail}`);
    } else if (p.type === "data-run-end") out.push(`[run ended: ${String(p.data?.note ?? "")}]`);
    else if (p.type === "data-checkpoint") out.push(`[saved version: ${String(p.data?.message ?? "")}]`);
  }
  if (!assistant) out.push("(no reply was saved for this run)");
  out.push(`\n## The user's next message\n${next ? truncateMiddle(textOf(next.parts), 2000) : "(none yet)"}`);
  return truncateMiddle(out.join("\n"), BUDGET);
}
