import type { UIMessage } from "ai";

/**
 * Turn-level compaction for the next run's prompt. The repository is the source of truth, so
 * earlier turns don't need their full tool transcripts: each earlier assistant turn becomes
 * its prose plus a one-line ledger of actions ("Changed src/App.tsx, src/Board.tsx · ran
 * npm install zod · verify passed"). The approved plan is kept in full because the build
 * follows it. The latest user message is untouched.
 */

type AnyPart = UIMessage["parts"][number] & { type: string; [k: string]: unknown };

const FILE_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

export function ledgerFor(parts: AnyPart[]): string | null {
  const changed = new Set<string>();
  const commands: string[] = [];
  const notes: string[] = [];
  for (const p of parts) {
    if (!p.type.startsWith("tool-")) continue;
    const name = p.type.slice(5);
    const input = (p.input ?? {}) as Record<string, unknown>;
    const output = (p.output ?? {}) as Record<string, unknown>;
    if (FILE_TOOLS.has(name) && typeof input.path === "string") changed.add(input.path);
    if (name === "run_command" && typeof input.command === "string") commands.push(`${input.command}${output.ok === false ? " (failed)" : ""}`);
    if (name === "verify") notes.push(`verify ${output.ok ? "passed" : "failed"}`);
    if (name === "research" && typeof input.task === "string") notes.push(`researched “${String(input.task).slice(0, 60)}”`);
  }
  const bits: string[] = [];
  if (changed.size) bits.push(`changed ${[...changed].slice(0, 15).join(", ")}${changed.size > 15 ? ` and ${changed.size - 15} more` : ""}`);
  if (commands.length) bits.push(`ran ${commands.slice(-5).join("; ")}`);
  bits.push(...notes.slice(-3));
  return bits.length ? `[Actions in this turn: ${bits.join(" · ")}]` : null;
}

export function compactHistory(messages: UIMessage[]): UIMessage[] {
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((m, i) => {
    if (i >= lastUser || m.role !== "assistant") return m;
    const parts = m.parts as AnyPart[];
    const keep: UIMessage["parts"] = [];
    for (const p of parts) {
      if (p.type === "text") keep.push(p as UIMessage["parts"][number]);
      // Keep approved plans verbatim; they define what to build.
      if (p.type === "tool-propose_plan" && p.input) {
        keep.push({ type: "text", text: `Proposed plan:\n${JSON.stringify(p.input, null, 2)}` });
      }
    }
    const ledger = ledgerFor(parts);
    if (ledger) keep.push({ type: "text", text: ledger });
    if (keep.length === 0) keep.push({ type: "text", text: "(no reply)" });
    return { ...m, parts: keep };
  });
}

/**
 * A short version title from the agent's final reply: its first sentence, without markdown,
 * "I've"/"I have", or a dangling "with the following features:" tail.
 * "I've built a habit tracker with the following features:" → "Built a habit tracker".
 */
export function versionTitle(reply: string | undefined): string {
  const line = ((reply ?? "").replace(/[#*`_>]/g, "").trim().split("\n")[0] ?? "").replace(/^(?:done|great|all set|perfect)[!,.]\s*/i, "");
  const sentence = (line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line).trim();
  let t = sentence.replace(/[.!?:]+$/, "").trim();
  // A list intro ("…a habit tracker that lets you:") keeps only what was built.
  if (sentence.endsWith(":")) t = t.replace(/\s+(?:that|which|where|so|with|including|featuring)\b.*$/i, "");
  t = t.replace(/^I(?:['’]ve| have)\s+/i, "").trim();
  if (!t) return "Update";
  t = t[0].toUpperCase() + t.slice(1);
  return t.length > 72 ? `${t.slice(0, 71).replace(/\s+\S*$/, "")}…` : t;
}

