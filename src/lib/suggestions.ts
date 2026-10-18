import { z } from "zod";
import { describeRule, ruleSchema, type Rule, type RulePreset } from "./rules";
import { validateSkill, type Skill } from "./skills/skill-file";
import { findSecret } from "./redact";

/**
 * Suggestions: what the agent learned, in the form that costs least. Text that is always in
 * the prompt is paid for on every turn, so the agent picks the cheapest form that works:
 *
 *   skill  → a procedure with a recognisable trigger; loaded only when it applies
 *   rule   → something that must happen every time; enforced by the harness, not by prose
 *   memory → a short fact for every turn (the remember tool; see lib/memory)
 *
 * The ordering follows Harness² (Google Research, Apache-2.0, arXiv:2610.14224), which found
 * always-on text the most expensive place to put new instruction. Nothing is applied until the
 * user keeps it.
 */

export const suggestInputSchema = z.object({
  kind: z.enum(["skill", "rule"]).describe("skill: a reusable procedure with a clear trigger. rule: something Daedalus must enforce every time."),
  name: z.string().min(2).max(64).describe("skill: lowercase words joined by hyphens, e.g. api-error-handling. rule: a short label, e.g. Run the tests before finishing"),
  description: z.string().min(3).max(1024).describe("skill: what it does and exactly when to use it. rule: why it should always happen."),
  instructions: z.string().max(20_000).optional().describe("skill only: the playbook in Markdown, concrete steps and checks"),
  event: z.enum(["before_finish", "before_command", "after_change"]).optional().describe("rule only: before_finish runs a command that must pass; before_command blocks matching commands; after_change runs a command on each changed file"),
  command: z.string().max(300).optional().describe("rule only (before_finish, after_change): the shell command; {file} is the changed file"),
  pattern: z.string().max(200).optional().describe("rule only (before_command): the command prefix or * pattern to block"),
  glob: z.string().max(120).optional().describe("rule only (after_change): which files, e.g. src/**/*.tsx"),
  evidence: z.string().min(10).max(2000).describe("What happened in this conversation that shows it's needed: the moment, not a general benefit"),
});
export type SuggestInput = z.infer<typeof suggestInputSchema>;

export type Suggestion =
  | { kind: "skill"; name: string; payload: Skill; evidence: string }
  | { kind: "rule"; name: string; payload: RulePreset; evidence: string };

/** Checks a suggestion and returns its stored form, or a message the agent can act on. */
export function normalizeSuggestion(input: SuggestInput): Suggestion | { error: string } {
  const evidence = input.evidence.trim();
  // Skills land in the repo and rules run every time: neither may carry a key or password.
  const secret = findSecret([input.description, input.instructions ?? "", input.command ?? "", input.pattern ?? "", evidence].join("\n"));
  if (secret) return { error: `Not suggested: it contains ${secret}. Never put secrets in skills or rules; refer to an environment variable instead.` };
  if (input.kind === "skill") {
    const skill: Skill = { name: input.name.trim().toLowerCase(), description: input.description.trim(), body: (input.instructions ?? "").trim() };
    const problem = validateSkill(skill);
    if (problem) return { error: problem };
    if (skill.body.length < 40) return { error: "Write the skill's instructions: the concrete steps and checks to follow when it applies." };
    return { kind: "skill", name: skill.name, payload: skill, evidence };
  }
  if (!input.event) return { error: "Say when the rule runs: event before_finish, before_command or after_change." };
  const label = input.name.trim().slice(0, 80);
  const candidate =
    input.event === "before_command"
      ? { event: input.event, label, pattern: input.pattern?.trim() ?? "", reason: input.description.trim().slice(0, 200) }
      : input.event === "after_change"
        ? { event: input.event, label, command: input.command?.trim() ?? "", glob: input.glob?.trim() || "**/*" }
        : { event: input.event, label, command: input.command?.trim() ?? "" };
  const parsed = ruleSchema.safeParse({ ...candidate, id: "suggested", enabled: true });
  if (!parsed.success) {
    const field = input.event === "before_command" ? "pattern" : "command";
    return { error: `This rule needs a ${field}.` };
  }
  const rule: Record<string, unknown> = { ...parsed.data };
  delete rule.id;
  delete rule.enabled;
  return { kind: "rule", name: label, payload: rule as unknown as RulePreset, evidence };
}

/** One line for a rule suggestion, as the Rules section would show it. */
export function describeSuggestedRule(rule: RulePreset): string {
  return describeRule({ ...rule, id: "x", enabled: true } as Rule);
}
