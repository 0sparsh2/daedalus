import { z } from "zod";

/**
 * Rules that always run: project rules the harness enforces whatever the model decides.
 * Instructions (AGENTS.md, skills) are requests; rules are guarantees. They live in Daedalus's
 * database (projects.settings.rules), not in a repo file the agent could edit to turn one off.
 *
 *   before_finish  → run a command; it must pass before a build can finish (failures go back
 *                    to the agent like the automatic check)
 *   before_command → block run_command calls that match a pattern
 *   after_change   → run a command on each changed file that matches a glob; its output is
 *                    shown to the agent (formatters, linters)
 */

const id = z.string().min(1).max(40);
const label = z.string().max(80).optional();
const enabled = z.boolean().default(true);

export const ruleSchema = z.discriminatedUnion("event", [
  z.object({ id, label, enabled, event: z.literal("before_finish"), command: z.string().min(1).max(300) }),
  z.object({ id, label, enabled, event: z.literal("before_command"), pattern: z.string().min(1).max(200), reason: z.string().max(200).optional() }),
  z.object({ id, label, enabled, event: z.literal("after_change"), command: z.string().min(1).max(300), glob: z.string().max(120).default("**/*") }),
]);
export const rulesSchema = z.array(ruleSchema).max(30);

export type Rule = z.infer<typeof ruleSchema>;
export type RuleEvent = Rule["event"];
/** A rule without its id and on/off state (presets); distributive, so each variant keeps its fields. */
export type RulePreset = Rule extends infer R ? (R extends Rule ? Omit<R, "id" | "enabled"> : never) : never;

export function rulesFor<E extends RuleEvent>(rules: Rule[] | undefined, event: E): Extract<Rule, { event: E }>[] {
  return (rules ?? []).filter((r): r is Extract<Rule, { event: E }> => r.enabled !== false && r.event === event);
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does a command match a block pattern? Without `*` the pattern is a prefix on word
 * boundaries ("npm install" blocks "npm install zod" but not "npm installer"); with `*` it's a
 * wildcard match over the whole command. Case-insensitive, whitespace-normalised.
 */
export function matchesCommand(pattern: string, command: string): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const p = norm(pattern);
  const c = norm(command);
  if (!p) return false;
  if (p.includes("*")) return new RegExp(`^${p.split("*").map(escape).join(".*")}$`).test(c);
  return c === p || c.startsWith(`${p} `) || c.split(/\s*(?:&&|\|\||;|\|)\s*/).some((part) => part === p || part.startsWith(`${p} `));
}

/** Glob match for repo paths: `*` within a segment, `**` across segments, `{a,b}` alternatives. */
export function matchesGlob(glob: string, path: string): boolean {
  const re = glob
    .split(/(\*\*\/?|\*|\{[^}]*\})/)
    .map((part) => {
      if (part === "**/" || part === "**") return "(?:.*/)?" + (part === "**" ? ".*" : "");
      if (part === "*") return "[^/]*";
      if (part.startsWith("{") && part.endsWith("}")) return `(?:${part.slice(1, -1).split(",").map(escape).join("|")})`;
      return escape(part);
    })
    .join("");
  return new RegExp(`^${re}$`).test(path.replace(/^\.\//, ""));
}

/** Puts the changed file's path into an after_change command, shell-quoted. `{file}` is the placeholder. */
export function withFile(command: string, file: string): string {
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  return command.includes("{file}") ? command.split("{file}").join(quoted) : `${command} ${quoted}`;
}

export function describeRule(r: Rule): string {
  if (r.event === "before_finish") return `Before finishing a change, run ${r.command}`;
  if (r.event === "before_command") return `Block commands matching ${r.pattern}`;
  return `When ${r.glob} changes, run ${r.command}`;
}
