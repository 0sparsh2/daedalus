import "server-only";
import { getWritable } from "workflow";
import { attachProjectSandbox, ensureProjectSandbox } from "@/lib/sandbox";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { endSpan, recordSpan, startSpan } from "@/lib/trace/spans";
import { emit, requestPreviewReload } from "./emit";
import { versionTitle } from "./history";
import type { PromptContext } from "./prompts";
import { stableId } from "./runtime";
import type { RouteDecision } from "./router";
import { routeOf, type RunScope } from "./scope";
import * as impl from "./tools/impl";
import type { PlainPart } from "./ui-parts";

/**
 * Durable steps around the agent loop: start (provision sandbox, gather context), the
 * automatic final check (the harness's own verify gate, independent of what the model
 * claims), and finish (git checkpoint, persist the assistant message, close the run).
 */

const RUN_NAME = { chat: "Chat", ask: "Answer", plan: "Plan run", build: "Build run" } as const;

export async function startRunStep(scope: RunScope, projectName: string): Promise<PromptContext> {
  "use step";
  const db = supabaseAdmin();
  const route = routeOf(scope);
  await db.from("runs").update({ status: "running" }).eq("id", scope.runId);
  await db.from("projects").update(route === "build" ? { status: "building", last_run_id: scope.runId } : { last_run_id: scope.runId }).eq("id", scope.projectId);
  await startSpan({
    id: scope.runId,
    runId: scope.runId,
    projectId: scope.projectId,
    userId: scope.userId,
    kind: "run",
    name: RUN_NAME[route],
    attrs: { provider: scope.provider, model: scope.model, subagentModel: scope.subagentModel, mode: scope.mode, route },
  });

  // Chat turns never touch the sandbox: their context comes from the database, so they answer at once.
  if (route === "chat") {
    const { data: versions, count } = await db
      .from("checkpoints")
      .select("message", { count: "exact" })
      .eq("project_id", scope.projectId)
      .order("created_at", { ascending: false })
      .limit(3);
    const state = count
      ? `${count} saved version${count === 1 ? "" : "s"}; latest: ${versions?.map((v) => v.message).join("; ")}`
      : "nothing built yet: the project is the starter app";
    return { projectName, fileTree: "", today: new Date().toISOString().slice(0, 10), state };
  }

  const sandboxSpan = stableId(scope.runId, "sandbox");
  const t0 = new Date();
  await startSpan({ id: sandboxSpan, runId: scope.runId, projectId: scope.projectId, userId: scope.userId, parentId: scope.runId, kind: "sandbox", name: "Prepare sandbox" });
  const stages: string[] = [];
  const { handle, previewUrl, created } = await ensureProjectSandbox(scope.projectId, async (e) => {
    stages.push(e.stage);
    await emit({ type: "data-status", id: "status", data: { stage: e.stage, note: e.note } });
  });
  await endSpan(sandboxSpan, { status: "ok", startedAt: t0, attrs: { provider: handle.provider, created, stages, previewUrl } });
  await emit({ type: "data-preview", id: "preview", data: { url: previewUrl } });

  const [tree, agents, log] = await Promise.all([
    impl.listFiles(handle, { depth: 4 }),
    handle.readFile("AGENTS.md"),
    handle.exec("git log --oneline -6 2>/dev/null || true", { timeoutMs: 15_000 }),
  ]);
  return {
    projectName,
    fileTree: tree.text,
    agentsMd: agents ? new TextDecoder().decode(agents).slice(0, 6000) : undefined,
    recentCommits: log.stdout.trim() || undefined,
    previewUrl,
    today: new Date().toISOString().slice(0, 10),
  };
}

export async function isCancelledStep(scope: RunScope): Promise<boolean> {
  "use step";
  const { data } = await supabaseAdmin().from("runs").select("status").eq("id", scope.runId).maybeSingle();
  return data?.status === "cancelled";
}

export interface FinalCheck {
  ok: boolean;
  skipped?: boolean;
  report?: string;
  problems?: number;
}

/** The harness's gate: type check, build and preview must pass before a build run ends. */
export async function finalCheckStep(scope: RunScope, round: number): Promise<FinalCheck> {
  "use step";
  const sandbox = await attachProjectSandbox(scope.projectId);
  const dirty = await sandbox.exec("git status --porcelain | head -n 1", { timeoutMs: 20_000 });
  if (!dirty.stdout.trim()) return { ok: true, skipped: true };

  const id = stableId(scope.runId, "final-check", String(round));
  const t0 = new Date();
  await emit({ type: "data-check", id: `check-${round}`, data: { round, status: "running" } });
  await startSpan({ id, runId: scope.runId, projectId: scope.projectId, userId: scope.userId, parentId: scope.runId, kind: "verify", name: `Automatic check #${round + 1}` });
  // Type check + build, and the preview check (with a fresh load in the user's browser), together.
  const checkId = `${id}-${t0.getTime()}`;
  const [v, p] = await Promise.all([
    impl.verify(sandbox),
    impl.checkPreview(sandbox, { projectId: scope.projectId, fresh: { checkId, requestReload: () => requestPreviewReload(checkId) } }),
  ]);
  const ok = v.ok && p.ok;
  const report = ok ? "" : [v.ok ? "" : v.text, p.ok ? "" : p.text].filter(Boolean).join("\n\n");
  await endSpan(id, { status: ok ? "ok" : "error", startedAt: t0, output: { verify: v.text.slice(0, 1500), preview: p.text.slice(0, 1500) } });
  await emit({
    type: "data-check",
    id: `check-${round}`,
    data: { round, status: ok ? "passed" : "failed", typecheck: v.typecheckOk, build: v.buildOk, preview: p.ok, problems: ok ? 0 : (v.diagnostics?.length ?? 0) + Number(p.problems ?? 0) },
  });
  // The agent's next round opens with `reset-step`, which clears the client's current step.
  // Start a fresh step first so this round's text and the check result stay on screen.
  if (!ok) await emit({ type: "start-step" });
  return {
    ok,
    problems: ok ? 0 : (v.diagnostics?.length ?? 0) + Number(p.problems ?? 0),
    report: ok
      ? undefined
      : `[Automatic check by Daedalus] Your changes don't pass yet, so the run can't finish. Fix these problems, then run verify and check_preview again:\n\n${report}`,
  };
}

export interface FinishInput {
  outcome: "succeeded" | "failed" | "cancelled";
  error?: string;
  /** The assistant message in order: model steps interleaved with automatic-check results. */
  parts: PlainPart[];
  assistantMessageId: string;
  planTitle?: string;
  /** The turn router's decision, saved with the message so the UI can show which agent answered. */
  route?: RouteDecision;
}

export async function finishRunStep(scope: RunScope, input: FinishInput) {
  "use step";
  const db = supabaseAdmin();
  const extra: PlainPart[] = [];

  let checkpoint: { sha: string; files: number } | null = null;
  if (routeOf(scope) === "build") {
    try {
      const sandbox = await attachProjectSandbox(scope.projectId);
      const lastText = [...input.parts].reverse().find((p) => p.type === "text")?.text as string | undefined;
      const title = versionTitle(lastText);
      checkpoint = await impl.commitCheckpoint(sandbox, title);
      if (checkpoint) {
        await db.from("checkpoints").insert({ project_id: scope.projectId, user_id: scope.userId, run_id: scope.runId, sha: checkpoint.sha, message: title, files_changed: checkpoint.files });
        const chunk = { type: "data-checkpoint" as const, id: "checkpoint", data: { sha: checkpoint.sha, message: title, files: checkpoint.files } };
        await emit(chunk);
        extra.push(chunk);
      }
    } catch (err) {
      console.error("[run] checkpoint failed", err);
    }
  }

  if (input.outcome !== "succeeded") {
    const note = input.outcome === "cancelled" ? "Stopped. Changes made so far are kept." : `The run stopped because of an error: ${input.error ?? "unknown error"}`;
    const chunk = { type: "data-run-end" as const, id: "run-end", data: { outcome: input.outcome, note } };
    await emit(chunk);
    extra.push(chunk);
  }

  const parts = [...input.parts, ...extra];
  await db.from("messages").upsert({
    id: input.assistantMessageId,
    project_id: scope.projectId,
    user_id: scope.userId,
    role: "assistant",
    parts,
    run_id: scope.runId,
    metadata: { runId: scope.runId, model: scope.model, provider: scope.provider, mode: scope.mode, route: input.route ?? { route: routeOf(scope), by: "default", reason: "" } },
  });

  const summary = ([...input.parts].reverse().find((p) => p.type === "text")?.text as string | undefined)?.slice(0, 500) ?? null;
  const { data: current } = await db.from("runs").select("status").eq("id", scope.runId).maybeSingle();
  const finalStatus = current?.status === "cancelled" ? "cancelled" : input.outcome;
  await db.from("runs").update({ status: finalStatus, ended_at: new Date().toISOString(), error: input.error ?? null, summary }).eq("id", scope.runId);
  const projectPatch: Record<string, unknown> = { status: "ready" };
  if (input.planTitle) projectPatch.name = input.planTitle.slice(0, 60);
  await db.from("projects").update(projectPatch).eq("id", scope.projectId);
  await endSpan(scope.runId, { status: finalStatus === "succeeded" ? "ok" : finalStatus === "cancelled" ? "cancelled" : "error", error: input.error, attrs: { checkpoint: checkpoint?.sha } });
  await recordSpan({
    runId: scope.runId,
    projectId: scope.projectId,
    userId: scope.userId,
    parentId: scope.runId,
    kind: "system",
    name: "Run finished",
    status: finalStatus === "succeeded" ? "ok" : finalStatus === "cancelled" ? "cancelled" : "error",
    endedAt: new Date(),
    attrs: { outcome: finalStatus, checkpoint: checkpoint?.sha, files: checkpoint?.files },
  });
  // The agent loop leaves the durable stream open between rounds; close it last so readers
  // (the live response and any reconnecting client) see the end of the run.
  await getWritable().close();
  return { status: finalStatus, checkpoint };
}
