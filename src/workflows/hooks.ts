import { defineHook } from "workflow";
import { z } from "zod";

/**
 * The user's answer to an "ask" tool call. The run waits on this hook (no compute while it
 * waits); the approvals API resumes it after checking the caller owns the run.
 */
export const toolApprovalHook = defineHook({
  schema: z.object({ decision: z.enum(["approved", "always", "denied", "stopped"]) }),
});

export type ApprovalDecision = "approved" | "always" | "denied" | "stopped" | "expired";

/** One token per tool call in a run, so the API (and Stop) can find the hook again. */
export const approvalToken = (runId: string, toolCallId: string) => `approval:${runId}:${toolCallId}`;
