import "server-only";
import { generateText } from "ai";
import { GatewayModel } from "@/lib/llm/gateway-model";
import type { AnyProviderId } from "@/lib/llm/providers";
import { mintRunToken } from "@/lib/llm/run-token";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { endSpan, startSpan } from "@/lib/trace/spans";
import { emit } from "./emit";
import { ROUTER_PROMPT, fitToMode, parseRoute, routerInput, ruleRoute, type Intent, type RouteDecision } from "./router";
import { errorDetail, stableId } from "./runtime";
import type { RunScope } from "./scope";
import { parseMentions } from "@/lib/mentions";

/**
 * The first step of every turn: decide the route (router.ts) before any sandbox or big prompt.
 * Rules and user actions decide most turns for free; otherwise one call to the fast sub-agent
 * model classifies the message, bounded at 12 s, and anything unclear falls back to the user's
 * mode. The decision is traced (with the classifier's own model call nested under it), stored
 * on the run, and streamed so the UI can show which agent answered.
 */
export async function routeTurnStep(
  scope: RunScope,
  input: { text: string; intent?: Intent; lastAssistant?: string; pendingPlan: boolean },
): Promise<RouteDecision> {
  "use step";
  const db = supabaseAdmin();
  const spanId = stableId(scope.runId, "router");
  const startedAt = new Date();
  await startSpan({ id: spanId, runId: scope.runId, projectId: scope.projectId, userId: scope.userId, parentId: scope.runId, kind: "system", name: "Router", input: { text: input.text.slice(0, 400), intent: input.intent, mode: scope.mode } });

  let decision = ruleRoute({ text: input.text, mode: scope.mode, intent: input.intent });
  let raw: string | undefined;
  if (!decision && scope.provider !== "mock") {
    const [{ count }, { data: project }] = await Promise.all([
      db.from("checkpoints").select("id", { count: "exact", head: true }).eq("project_id", scope.projectId),
      db.from("projects").select("source").eq("id", scope.projectId).maybeSingle(),
    ]);
    const token = await mintRunToken({ userId: scope.userId, runId: scope.runId, projectId: scope.projectId, provider: scope.provider as AnyProviderId, spanId, agent: "router" });
    // Routing is a small decision: keep reasoning short where the provider supports the option.
    const lowEffort = scope.provider === "nvidia" || scope.provider === "openai" ? { [scope.provider]: { reasoningEffort: "low" } } : undefined;
    try {
      const { text } = await generateText({
        model: new GatewayModel({ provider: scope.provider as AnyProviderId, modelId: scope.subagentModel, gatewayURL: scope.gatewayURL, token }),
        system: ROUTER_PROMPT,
        prompt: routerInput({ text: input.text, mode: scope.mode, lastAssistant: input.lastAssistant, hasWork: (count ?? 0) > 0 || Boolean(project?.source), pendingPlan: input.pendingPlan }),
        maxOutputTokens: 1024,
        temperature: 0,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(12_000),
        providerOptions: lowEffort as never,
      });
      raw = text;
      const parsed = parseRoute(text);
      if (parsed) decision = { route: fitToMode(parsed.route, scope.mode), by: "model", reason: parsed.reason || "Classified by the router model" };
    } catch (err) {
      raw = `router model failed: ${errorDetail(err)}`;
    }
  }
  decision ??= { route: scope.mode, by: "default", reason: "Unclear, so it followed the selected mode" };
  // Chat turns don't open the sandbox, so a message that points at files or skills is at least a question.
  const mentions = parseMentions(input.text);
  if (decision.route === "chat" && (mentions.files.length || mentions.skills.length)) {
    decision = { route: "ask", by: "rule", reason: "It mentions files or skills, so it reads the project" };
  }

  await Promise.all([
    endSpan(spanId, { status: "ok", startedAt, output: { ...decision, raw: raw?.slice(0, 600) }, attrs: { route: decision.route, by: decision.by } }),
    db.from("runs").update({ route: decision.route }).eq("id", scope.runId),
    // Metadata, not a part: each agent loop opens with reset-step, which clears the current step's parts.
    emit({ type: "message-metadata", messageMetadata: { route: decision } }),
  ]);
  return decision;
}

const AGENT_LABEL = { chat: "chat", ask: "answer", plan: "planner", build: "builder", review: "reviewer" } as const;

/** A run token labelled with the agent the router chose, so the trace names who made each model call. */
export async function agentTokenStep(scope: RunScope, route: RouteDecision["route"]): Promise<string> {
  "use step";
  return mintRunToken({ userId: scope.userId, runId: scope.runId, projectId: scope.projectId, provider: scope.provider as AnyProviderId, spanId: scope.runId, agent: AGENT_LABEL[route] });
}
