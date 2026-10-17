import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, hasToolCall, isStepCount, jsonSchema, tool, type JSONSchema7, type ModelMessage, type StopCondition, type ToolSet, type UIMessage } from "ai";
import { getWritable } from "workflow";
import { compactHistory, turnFacts } from "@/lib/agent/history";
import { STEP_LIMIT, makePrepareStep } from "@/lib/agent/loop";
import { askPrompt, buildPrompt, chatPrompt, planPrompt, type PromptContext } from "@/lib/agent/prompts";
import { repairToolCall } from "@/lib/agent/repair";
import { agentTokenStep, routeTurnStep } from "@/lib/agent/route-step";
import type { Intent, Route } from "@/lib/agent/router";
import { finalCheckStep, finishRunStep, isCancelledStep, startRunStep } from "@/lib/agent/run-steps";
import type { RunScope } from "@/lib/agent/scope";
import { ASK_TOOLS, BUILD_TOOLS, PLAN_TOOLS, buildTools, type ToolName } from "@/lib/agent/tools";
import { mcpToolStep } from "@/lib/agent/tools/steps";
import { stepsToParts, type PlainPart } from "@/lib/agent/ui-parts";
import { GatewayModel } from "@/lib/llm/gateway-model";
import type { AnyProviderId } from "@/lib/llm/providers";

/**
 * One user turn = one durable workflow run.
 *
 *   route (rules, or one fast-model call) → start (sandbox + context; skipped for chat) →
 *   agent loop for that route (WorkflowAgent: every model call and tool call is its own
 *   retried step) → automatic check, build turns only (verify + preview; failures go back to
 *   the agent, up to 3 rounds) → finish (git checkpoint, persist message, close run)
 *
 * The run survives function timeouts, deploys and crashes; the UI can reconnect to its stream.
 */

export interface AgentRunInput {
  scope: RunScope;
  projectName: string;
  history: UIMessage[];
  token: string;
  assistantMessageId: string;
  /** What the user did beyond typing: pressed "Start building", or answered the agent's questions. */
  intent?: Intent;
}

const MAX_CHECK_ROUNDS = 3;

/** Each route is an agent profile: prompt, tools, and when its loop stops. Any of them may simply reply. */
const PROFILES: Record<Route, { tools: ToolName[]; stopWhen: () => StopCondition<ToolSet>[] }> = {
  chat: { tools: [], stopWhen: () => [isStepCount(STEP_LIMIT.chat)] },
  ask: { tools: ASK_TOOLS, stopWhen: () => [isStepCount(STEP_LIMIT.ask), hasToolCall("ask_user")] },
  plan: { tools: PLAN_TOOLS, stopWhen: () => [isStepCount(STEP_LIMIT.plan), hasToolCall("propose_plan"), hasToolCall("ask_user")] },
  build: { tools: BUILD_TOOLS, stopWhen: () => [isStepCount(STEP_LIMIT.build), hasToolCall("ask_user")] },
};

function promptFor(route: Route, c: PromptContext): string {
  if (route === "chat") return chatPrompt({ projectName: c.projectName, state: c.state ?? "", today: c.today });
  if (route === "ask") return askPrompt(c);
  if (route === "plan") return planPrompt(c);
  return buildPrompt(c);
}

export async function agentRun(input: AgentRunInput) {
  "use workflow";
  const writable = getWritable<ModelCallStreamPart>();
  const parts: PlainPart[] = [];
  let outcome: "succeeded" | "failed" | "cancelled" = "succeeded";
  let error: string | undefined;
  let planTitle: string | undefined;

  // 1. Route the turn before anything heavy starts.
  const facts = turnFacts(input.history);
  const decision = await routeTurnStep(input.scope, { text: facts.text, intent: input.intent, lastAssistant: facts.lastAssistant, pendingPlan: facts.pendingPlan });
  const route = decision.route;
  const scope: RunScope = { ...input.scope, route };

  let context: PromptContext;
  try {
    context = await startRunStep(scope, input.projectName);
  } catch (err) {
    error = `Couldn't prepare the sandbox: ${err instanceof Error ? err.message : String(err)}`;
    await finishRunStep(scope, { outcome: "failed", error, parts, assistantMessageId: input.assistantMessageId, route: decision });
    return { outcome: "failed" as const, route };
  }

  const profile = PROFILES[route];
  const builtIn = buildTools();
  const toolsContext = Object.fromEntries(Object.keys(builtIn).map((k) => [k, scope])) as Record<ToolName, RunScope>;
  // Connected MCP servers' tools: all of them in build turns, read-only ones elsewhere, none in chat.
  const mcp = route === "chat" ? [] : (context.connections ?? []).filter((d) => route === "build" || d.readOnly);
  const tools: ToolSet = {
    ...builtIn,
    ...Object.fromEntries(
      mcp.map((d) => [
        d.key,
        tool({
          description: d.description,
          inputSchema: jsonSchema(d.inputSchema as JSONSchema7),
          execute: (args, o) => mcpToolStep({ connectionId: d.connectionId, connection: d.connection, tool: d.tool, args: (args ?? {}) as Record<string, unknown>, readOnly: d.readOnly }, { toolCallId: o.toolCallId, scope }),
        }),
      ]),
    ),
  };
  const token = route === input.scope.mode ? input.token : await agentTokenStep(scope, route);
  const agent = new WorkflowAgent({
    model: new GatewayModel({ provider: scope.provider as AnyProviderId, modelId: scope.model, gatewayURL: scope.gatewayURL, token }),
    instructions: promptFor(route, context),
    tools,
    // Built-in tools read the run scope from their context; connection tools carry it themselves.
    toolsContext: toolsContext as never,
    activeTools: [...profile.tools, ...mcp.map((d) => d.key)] as ToolName[],
    prepareStep: makePrepareStep({ contextWindow: scope.contextWindow, route }),
    repairToolCall,
    maxRetries: 3,
    maxOutputTokens: scope.maxOutputTokens,
    providerOptions: scope.requestOptions ? { [scope.provider]: scope.requestOptions as Record<string, never> } : undefined,
  });

  try {
    let messages: ModelMessage[] = await convertToModelMessages(compactHistory(input.history), { tools, ignoreIncompleteToolCalls: true });
    const rounds = route === "build" ? MAX_CHECK_ROUNDS : 1;
    for (let round = 0; round < rounds; round++) {
      const result = await agent.stream({
        messages,
        writable,
        stopWhen: profile.stopWhen(),
        preventClose: true,
        sendFinish: false,
        // Collect each step as it completes, so a stopped or failed round keeps its work.
        onStepEnd: (step) => {
          parts.push(...stepsToParts([step]));
        },
      });
      // The agent's instructions come back as a system message; they are re-sent via `instructions`.
      messages = result.messages.filter((m) => m.role !== "system");
      if ("error" in result && result.error) {
        if (await isCancelledStep(scope)) outcome = "cancelled";
        else {
          outcome = "failed";
          error = describeError(result.error);
        }
        break;
      }
      const calls = result.steps.flatMap((s) => s.toolCalls ?? []);
      const plan = calls.find((c) => c.toolName === "propose_plan");
      if (plan) planTitle = (plan.input as { title?: string } | undefined)?.title;
      // Questions for the user end the turn: their answer comes as the next message.
      if (route !== "build" || calls.some((c) => c.toolName === "ask_user")) break;
      if (await isCancelledStep(scope)) {
        outcome = "cancelled";
        break;
      }
      const check = await finalCheckStep(scope, round);
      if (check.skipped) break;
      parts.push({ type: "data-check", id: `check-${round}`, data: { round, status: check.ok ? "passed" : "failed", problems: check.problems, rules: check.rules } });
      if (check.ok || round === rounds - 1) break;
      parts.push({ type: "step-start" });
      messages = [...messages, { role: "user", content: [{ type: "text", text: check.report ?? "" }] }];
    }
  } catch (err) {
    // Whatever went wrong, the run must still end cleanly: persist, checkpoint, close the stream.
    outcome = "failed";
    error = describeError(err);
  }

  await finishRunStep(scope, { outcome, error, parts, assistantMessageId: input.assistantMessageId, planTitle, route: decision });
  return { outcome, route };
}

function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: string; statusCode?: number; responseBody?: string };
    const body = typeof o.responseBody === "string" ? o.responseBody.slice(0, 300) : "";
    return [o.statusCode ? `HTTP ${o.statusCode}` : "", o.message ?? "", body].filter(Boolean).join(" · ");
  }
  return String(e);
}
