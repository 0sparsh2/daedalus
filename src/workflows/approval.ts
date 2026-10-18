import { sleep } from "workflow";
import { requestApprovalStep, settleApprovalStep, type ApprovalRequest } from "@/lib/agent/approval-steps";
import type { RunScope } from "@/lib/agent/scope";
import { approvalToken, toolApprovalHook, type ApprovalDecision } from "./hooks";

/** How long an "ask" call waits for the user before it counts as declined. */
const APPROVAL_TIMEOUT = "15m";

/**
 * The approval gate for "ask" tools, run in the workflow (hooks are workflow-level). The run
 * pauses on a hook keyed by run and tool call; the user's Allow once / Always allow / Deny,
 * Stop, or the timeout resumes it. Durable: a deploy or crash while waiting loses nothing.
 */
export async function approvalGate(scope: RunScope, req: Omit<ApprovalRequest, "token">): Promise<ApprovalDecision> {
  const token = approvalToken(scope.runId, req.toolCallId);
  const hook = toolApprovalHook.create({ token });
  const r = { ...req, token };
  await requestApprovalStep(scope, r);
  const result = await Promise.race([hook, sleep(APPROVAL_TIMEOUT).then(() => ({ decision: "expired" as const }))]);
  await settleApprovalStep(scope, r, result.decision);
  return result.decision;
}

export function approvalNote(decision: ApprovalDecision, tool: string): string {
  switch (decision) {
    case "denied":
      return `The user declined this ${tool} call. Don't retry it; carry on without it, or ask the user what they'd like instead.`;
    case "stopped":
      return "The user stopped the run.";
    case "expired":
      return `Nobody approved this ${tool} call within 15 minutes, so it wasn't made. Carry on without it and mention that it needs approval.`;
    default:
      return "";
  }
}
