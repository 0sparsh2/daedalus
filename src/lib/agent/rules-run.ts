import "server-only";
import type { SandboxHandle } from "@/lib/sandbox";
import { describeRule, matchesCommand, matchesGlob, rulesFor, rulesSchema, withFile, type Rule } from "@/lib/rules";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { truncateMiddle } from "./runtime";

/** The project's rules from Daedalus's database; invalid or missing settings mean no rules. */
export async function projectRules(projectId: string): Promise<Rule[]> {
  const { data } = await supabaseAdmin().from("projects").select("settings").eq("id", projectId).maybeSingle();
  const parsed = rulesSchema.safeParse(((data?.settings ?? {}) as { rules?: unknown }).rules ?? []);
  return parsed.success ? parsed.data : [];
}

export function blockingRule(rules: Rule[], command: string) {
  return rulesFor(rules, "before_command").find((r) => matchesCommand(r.pattern, command));
}

export const ruleName = (r: Rule) => r.label?.trim() || describeRule(r);

/** Runs after_change rules for one changed file; returns text to append to the tool's result. */
export async function runAfterChange(sbx: SandboxHandle, rules: Rule[], path: string): Promise<string> {
  const notes: string[] = [];
  for (const rule of rulesFor(rules, "after_change").filter((r) => matchesGlob(r.glob, path))) {
    const r = await sbx.exec(withFile(rule.command, path), { timeoutMs: 60_000 });
    const out = truncateMiddle(`${r.stdout}\n${r.stderr}`.trim(), 1500);
    notes.push(`[Rule "${ruleName(rule)}" ran \`${withFile(rule.command, path)}\`: exit ${r.exitCode}${r.timedOut ? ", timed out" : ""}]${out ? `\n${out}` : ""}`);
  }
  return notes.length ? `\n\n${notes.join("\n\n")}` : "";
}

/** Runs before_finish rules; every one must exit 0 for the build to finish. */
export async function runBeforeFinish(sbx: SandboxHandle, rules: Rule[]) {
  const results: Array<{ name: string; command: string; ok: boolean; output: string }> = [];
  for (const rule of rulesFor(rules, "before_finish")) {
    const r = await sbx.exec(rule.command, { timeoutMs: 180_000 });
    results.push({ name: ruleName(rule), command: rule.command, ok: r.exitCode === 0 && !r.timedOut, output: truncateMiddle(`${r.stdout}\n${r.stderr}`.trim(), 2500) });
  }
  return { ok: results.every((r) => r.ok), results };
}
