import { createUIMessageStreamResponse } from "ai";
import { start } from "workflow/api";
import { z } from "zod";
import { createUITransform } from "@/lib/agent/ui-transform";
import { getActiveModel, listCredentials } from "@/lib/credentials";
import { env } from "@/lib/env";
import { HttpError, jsonError, withUser } from "@/lib/http";
import { isMockEnabled } from "@/lib/llm/mock-llm";
import { PROVIDERS, getModelInfo, isProviderId, maxOutputFor, subagentModelFor, type AnyProviderId } from "@/lib/llm/providers";
import { mintRunToken } from "@/lib/llm/run-token";
import { activeRun, createProject, getProject, loadMessages, nameFromPrompt } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { agentRun } from "@/workflows/agent-run";

export const maxDuration = 300;

const bodySchema = z.object({
  projectId: z.string().uuid().optional(),
  message: z.object({
    id: z.string().min(1).max(100),
    role: z.literal("user"),
    parts: z.array(z.object({ type: z.string() }).passthrough()).min(1),
  }),
  mode: z.enum(["plan", "build"]).default("build"),
  /** What the user did beyond typing: pressed "Start building", or answered the agent's questions. */
  intent: z.enum(["build", "answer", "review"]).optional(),
  model: z.object({ provider: z.string(), model: z.string() }).optional(),
});

/**
 * Starts one agent turn: validates the user's model access, persists the user message,
 * records a run, and starts the durable workflow. The response streams the run live; the
 * workflow keeps going if the browser disconnects and the client can reconnect.
 */
export async function POST(req: Request) {
  return withUser(async (user) => {
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid request", "bad_request", { issues: parsed.error.issues.slice(0, 5) });
    const { message, mode } = parsed.data;
    const text = message.parts.map((p) => (p.type === "text" ? String((p as { text?: string }).text ?? "") : "")).join(" ").trim();
    if (!text) return jsonError(400, "Message is empty", "bad_request");

    // Which model? An explicit pick must be a provider the user holds a key for (BYOK).
    let provider: AnyProviderId;
    let model: string;
    if (parsed.data.model) {
      const p = parsed.data.model.provider;
      if (p === "mock" && isMockEnabled()) provider = "mock";
      else if (isProviderId(p)) {
        const creds = await listCredentials(user.id);
        if (!creds.some((c) => c.provider === p && c.status === "valid")) {
          return jsonError(412, `Add your ${PROVIDERS[p].label} API key to use this model.`, "needs_key", { provider: p });
        }
        provider = p;
      } else return jsonError(400, "Unknown provider", "bad_request");
      model = parsed.data.model.model;
    } else {
      const active = await getActiveModel(user.id);
      if (!active) return jsonError(412, "Add an API key to start building.", "needs_key");
      provider = active.provider;
      model = active.model;
    }

    // Project: create on first message.
    const project = parsed.data.projectId ? await getProject(user.id, parsed.data.projectId) : await createProject(user.id, nameFromPrompt(text), text.slice(0, 500));

    const running = await activeRun(project.id);
    if (running) return jsonError(409, "A run is already in progress for this project.", "run_in_progress", { runId: running.id, workflowRunId: running.workflow_run_id });

    const db = supabaseAdmin();

    const { data: run, error: runErr } = await db
      .from("runs")
      .insert({ project_id: project.id, user_id: user.id, mode, provider, model, status: "queued" })
      .select("id")
      .single();
    if (runErr?.code === "23505") return jsonError(409, "A run is already in progress for this project.", "run_in_progress");
    if (runErr || !run) throw new HttpError(500, runErr?.message ?? "Couldn't create the run");

    // Saved after the run row exists, so a rejected duplicate Send leaves no orphan message.
    const { error: msgErr } = await db.from("messages").upsert({ id: message.id, project_id: project.id, user_id: user.id, role: "user", parts: message.parts, metadata: { mode, runId: run.id } });
    if (msgErr) {
      await db.from("runs").update({ status: "failed", error: "Couldn't save the message", ended_at: new Date().toISOString() }).eq("id", run.id);
      throw new HttpError(500, msgErr.message);
    }

    const history = await loadMessages(project.id);
    const token = await mintRunToken({ userId: user.id, runId: run.id, projectId: project.id, provider, spanId: run.id, agent: mode === "plan" ? "planner" : "builder" });
    const assistantMessageId = `a-${run.id}`;
    const wf = await start(agentRun, [
      {
        scope: {
          runId: run.id,
          projectId: project.id,
          userId: user.id,
          provider,
          model,
          subagentModel: pickSubagentModel(provider, model, project.settings?.subagentModel),
          gatewayURL: `${gatewayBase(req)}/api/gateway`,
          mode,
          contextWindow: getModelInfo(provider, model).context,
          maxOutputTokens: maxOutputFor(provider, model),
          requestOptions: getModelInfo(provider, model).requestOptions,
          subagentRequestOptions: getModelInfo(provider, pickSubagentModel(provider, model, project.settings?.subagentModel)).requestOptions,
        },
        projectName: project.name,
        history,
        token,
        assistantMessageId,
        intent: parsed.data.intent,
      },
    ]);
    await db.from("runs").update({ workflow_run_id: wf.runId }).eq("id", run.id);

    return createUIMessageStreamResponse({
      stream: wf.readable.pipeThrough(createUITransform({ messageId: assistantMessageId, metadata: { runId: run.id, projectId: project.id } })),
      headers: { "x-workflow-run-id": wf.runId, "x-daedalus-run-id": run.id, "x-daedalus-project-id": project.id },
    });
  });
}

/** The project's chosen sub-agent model if it belongs to the run's provider, else the provider's fast model. */
function pickSubagentModel(provider: AnyProviderId, model: string, preferred?: string): string {
  if (preferred && PROVIDERS[provider].models.some((m) => m.id === preferred)) return preferred;
  return subagentModelFor(provider, model);
}

/**
 * The URL the agent's model client uses to reach this deployment's gateway: the origin the
 * user came through (the production domain is public). Not VERCEL_URL: unique deployment URLs
 * sit behind Vercel's deployment protection, so server-to-server calls to them get a 401.
 */
function gatewayBase(req: Request): string {
  if (process.env.DAEDALUS_GATEWAY_BASE_URL) return process.env.DAEDALUS_GATEWAY_BASE_URL.replace(/\/$/, "");
  const fwdHost = req.headers.get("x-forwarded-host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  if (fwdHost) return `${proto}://${fwdHost}`;
  return new URL(req.url).origin || env.appUrl();
}
