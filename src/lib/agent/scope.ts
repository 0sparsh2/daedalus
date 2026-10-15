import { z } from "zod";

/**
 * Everything a tool step needs to find its run, project and sandbox. Plain data: it is written
 * to the workflow event log and handed to every step, so it must never hold a secret.
 */
export const runScopeSchema = z.object({
  runId: z.string(),
  projectId: z.string(),
  userId: z.string(),
  provider: z.string(),
  model: z.string(),
  subagentModel: z.string(),
  gatewayURL: z.string(),
  mode: z.enum(["plan", "build"]),
  contextWindow: z.number(),
});

export type RunScope = z.infer<typeof runScopeSchema>;

/** Shape every tool returns. `text` is what the model reads; the rest feeds the UI. */
export interface ToolOutput {
  ok: boolean;
  text: string;
  [key: string]: unknown;
}
