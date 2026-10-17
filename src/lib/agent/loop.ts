import type { LanguageModelV4Message, LanguageModelV4Prompt } from "@ai-sdk/provider";

/**
 * Loop control for the agent. Pure functions only: they run inside the durable workflow,
 * which replays them, so they must be deterministic. They operate on the provider-level
 * prompt (what WorkflowAgent hands to prepareStep).
 *
 *  - Context pruning: when the conversation nears the model's window, old tool outputs are
 *    replaced with a one-line stub (the files are still on disk; the agent can re-read).
 *  - Doom-loop guard: the same tool call with the same input three steps running triggers a
 *    corrective note instead of a fourth identical attempt.
 *  - Step budget: near the limit, the agent is told to verify and wrap up; on the last step its
 *    tools are switched off, so a long run always ends with a summary instead of mid-action.
 */

export const STEP_LIMIT = { chat: 1, ask: 20, plan: 24, build: 70 } as const;
const KEEP_RECENT_TOOL_RESULTS = 8;

export function estimateTokens(messages: LanguageModelV4Prompt): number {
  let chars = 0;
  for (const m of messages) chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  return Math.ceil(chars / 3.6);
}

/** Replaces all but the most recent tool results with a stub. Returns the same array if nothing changed. */
export function pruneToolResults(messages: LanguageModelV4Prompt, keep = KEEP_RECENT_TOOL_RESULTS): LanguageModelV4Prompt {
  const positions: Array<[number, number]> = [];
  messages.forEach((m, i) => {
    if (m.role !== "tool") return;
    m.content.forEach((part, j) => {
      if (part.type === "tool-result") positions.push([i, j]);
    });
  });
  if (positions.length <= keep) return messages;
  const prune = new Set(positions.slice(0, positions.length - keep).map(([i, j]) => `${i}:${j}`));
  return messages.map((m, i): LanguageModelV4Message => {
    if (m.role !== "tool") return m;
    return {
      ...m,
      content: m.content.map((part, j) => {
        if (part.type !== "tool-result" || !prune.has(`${i}:${j}`)) return part;
        return { ...part, output: { type: "text" as const, value: `[Earlier ${part.toolName} output removed to save context. Re-run the tool if you need it again.]` } };
      }),
    };
  });
}

interface StepLike {
  toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }>;
}

export function detectLoop(steps: readonly StepLike[]): string | null {
  if (steps.length < 3) return null;
  const sig = (s: StepLike) => (s.toolCalls ?? []).map((c) => `${c.toolName}:${JSON.stringify(c.input)}`).sort().join("|");
  const last = steps.slice(-3).map(sig);
  if (last[0] && last.every((x) => x === last[0])) {
    const name = steps[steps.length - 1].toolCalls?.[0]?.toolName ?? "a tool";
    return `[Harness] You have called ${name} with exactly the same input three times in a row and it is not making progress. Stop repeating it. Re-read the latest error or output, form a different hypothesis, and try a different approach (read the relevant file, search the code, or research the API).`;
  }
  return null;
}

export function budgetNote(stepNumber: number, limit: number): string | null {
  if (stepNumber === limit - 4) {
    return "[Harness] You have 4 steps left in this run. Finish the current change, run verify, and then write your summary for the user. Leave any remaining items as suggestions.";
  }
  return null;
}

export const FINAL_STEP_NOTE =
  "[Harness] This is the last step of this run, so your tools are off. Write your reply to the user now: what you did, what still remains (if anything), and what they could ask for next. No tool calls.";

export function makePrepareStep(opts: { contextWindow: number; route: keyof typeof STEP_LIMIT }) {
  const limit = STEP_LIMIT[opts.route];
  const pruneAt = Math.floor(opts.contextWindow * 0.55);
  return ({ stepNumber, steps, messages }: { stepNumber: number; steps: readonly StepLike[]; messages: LanguageModelV4Prompt }) => {
    let next = messages;
    if (estimateTokens(next) > pruneAt) next = pruneToolResults(next);
    if (estimateTokens(next) > pruneAt) next = pruneToolResults(next, 3);
    const last = limit > 1 && stepNumber >= limit - 1;
    const notes = [detectLoop(steps), budgetNote(stepNumber, limit), last ? FINAL_STEP_NOTE : null].filter((n): n is string => Boolean(n));
    if (notes.length) next = [...next, { role: "user", content: [{ type: "text", text: notes.join("\n\n") }] }];
    if (last) return { messages: next, activeTools: [] as never[] };
    return next === messages ? {} : { messages: next };
  };
}
