import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { convertToModelMessages, hasToolCall, isStepCount, type ModelMessage, type UIMessage } from "ai";
import { getWritable } from "workflow";
import { compactHistory } from "@/lib/agent/history";
import { STEP_LIMIT, makePrepareStep } from "@/lib/agent/loop";
import { buildPrompt, planPrompt, type PromptContext } from "@/lib/agent/prompts";
import { repairToolCall } from "@/lib/agent/repair";
import { finalCheckStep, finishRunStep, isCancelledStep, startRunStep } from "@/lib/agent/run-steps";
import type { RunScope } from "@/lib/agent/scope";
import { BUILD_TOOLS, PLAN_TOOLS, buildTools, type ToolName } from "@/lib/agent/tools";
import { stepsToParts, type PlainPart } from "@/lib/agent/ui-parts";
import { GatewayModel } from "@/lib/llm/gateway-model";
import type { AnyProviderId } from "@/lib/llm/providers";

/**
 * One user turn = one durable workflow run.
 *
 *   start step (sandbox + context) → agent loop (WorkflowAgent: every model call and tool call
 *   is its own retried step) → automatic check (verify + preview; failures go back to the
 *   agent, up to 3 rounds) → finish step (git checkpoint, persist message, close run)
 *
 * The run survives function timeouts, deploys and crashes; the UI can reconnect to its stream.
 */

export interface AgentRunInput {
  scope: RunScope;
  projectName: string;
  history: UIMessage[];
  token: string;
  assistantMessageId: string;
}

const MAX_CHECK_ROUNDS = 3;

export async function agentRun(input: AgentRunInput) {
  "use workflow";
  const { scope } = input;
  const writable = getWritable<ModelCallStreamPart>();
  const parts: PlainPart[] = [];
  let outcome: "succeeded" | "failed" | "cancelled" = "succeeded";
  let error: string | undefined;
  let planTitle: string | undefined;

  let context: PromptContext;
  try {
    context = await startRunStep(scope, input.projectName);
  } catch (err) {
    error = `Couldn't prepare the sandbox: ${err instanceof Error ? err.message : String(err)}`;
    await finishRunStep(scope, { outcome: "failed", error, parts, assistantMessageId: input.assistantMessageId });
    return { outcome: "failed" as const };
  }

  const tools = buildTools();
  const toolsContext = Object.fromEntries(Object.keys(tools).map((k) => [k, scope])) as Record<ToolName, RunScope>;
  const agent = new WorkflowAgent({
    model: new GatewayModel({ provider: scope.provider as AnyProviderId, modelId: scope.model, gatewayURL: scope.gatewayURL, token: input.token }),
    instructions: scope.mode === "plan" ? planPrompt(context) : buildPrompt(context),
    tools,
    toolsContext,
    activeTools: scope.mode === "plan" ? PLAN_TOOLS : BUILD_TOOLS,
    prepareStep: makePrepareStep({ contextWindow: scope.contextWindow, mode: scope.mode }),
    repairToolCall,
    maxRetries: 3,
    maxOutputTokens: scope.maxOutputTokens,
  });

  try {
    let messages: ModelMessage[] = await convertToModelMessages(compactHistory(input.history), { tools, ignoreIncompleteToolCalls: true });
    const rounds = scope.mode === "build" ? MAX_CHECK_ROUNDS : 1;
    for (let round = 0; round < rounds; round++) {
      const result = await agent.stream({
        messages,
        writable,
        stopWhen: scope.mode === "plan" ? [isStepCount(STEP_LIMIT.plan), hasToolCall("propose_plan")] : isStepCount(STEP_LIMIT.build),
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
      if (scope.mode === "plan") {
        const plan = result.steps.flatMap((s) => s.toolCalls ?? []).find((c) => c.toolName === "propose_plan");
        planTitle = (plan?.input as { title?: string } | undefined)?.title;
        break;
      }
      if (await isCancelledStep(scope)) {
        outcome = "cancelled";
        break;
      }
      const check = await finalCheckStep(scope, round);
      if (check.skipped) break;
      parts.push({ type: "data-check", id: `check-${round}`, data: { round, status: check.ok ? "passed" : "failed", problems: check.problems } });
      if (check.ok || round === rounds - 1) break;
      parts.push({ type: "step-start" });
      messages = [...messages, { role: "user", content: [{ type: "text", text: check.report ?? "" }] }];
    }
  } catch (err) {
    // Whatever went wrong, the run must still end cleanly: persist, checkpoint, close the stream.
    outcome = "failed";
    error = describeError(err);
  }

  await finishRunStep(scope, { outcome, error, parts, assistantMessageId: input.assistantMessageId, planTitle });
  return { outcome };
}

function describeError(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { message?: string; statusCode?: number; responseBody?: string };
    const body = typeof o.responseBody === "string" ? o.responseBody.slice(0, 300) : "";
    return [o.statusCode ? `HTTP ${o.statusCode}` : "", o.message ?? "", body].filter(Boolean).join(" · ");
  }
  return String(e);
}
