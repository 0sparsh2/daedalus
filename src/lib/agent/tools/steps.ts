import "server-only";
import { requestPreviewReload } from "../emit";
import { runSubagent } from "../subagents";
import { callConnectionTool } from "@/lib/mcp/connections";
import { proposeMemory } from "@/lib/memory/memory";
import { runTool, stableId, ToolError, truncateMiddle } from "../runtime";
import type { SandboxHandle } from "@/lib/sandbox";
import { loadSkill } from "@/lib/skills/project";
import { blockingRule, projectRules, ruleName, runAfterChange } from "../rules-run";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { routeOf, type RunScope, type ToolOutput } from "../scope";
import * as impl from "./impl";

/**
 * Durable steps, one per tool. Each runs in its own invocation with automatic retries for
 * transient failures. Arguments are kept small on purpose (input, call id, scope): the
 * agent's full message history is never copied into the event log.
 */

type Ctx = { toolCallId: string; scope: RunScope };

export async function listFilesStep(input: { path?: string; depth?: number }, ctx: Ctx) {
  "use step";
  return runTool("list_files", input, ctx, (s) => impl.listFiles(s, input));
}

export async function readFileStep(input: { path: string; offset?: number; limit?: number }, ctx: Ctx) {
  "use step";
  return runTool("read_file", input, ctx, (s) => impl.readFile(s, input));
}

export async function writeFileStep(input: { path: string; content: string }, ctx: Ctx) {
  "use step";
  if (routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
  // Keep the event log lean: the content is in the model's tool call already.
  return runTool("write_file", { path: input.path, bytes: input.content.length }, ctx, async (s) => afterChange(s, ctx, input.path, await impl.writeFile(s, input)));
}

export async function editFileStep(input: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx: Ctx) {
  "use step";
  if (routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
  return runTool("edit_file", input, ctx, async (s) => afterChange(s, ctx, input.path, await impl.editFile(s, input)));
}

export async function deleteFileStep(input: { path: string }, ctx: Ctx) {
  "use step";
  if (routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
  return runTool("delete_file", input, ctx, (s) => impl.deleteFile(s, input));
}

/** Project rules that run when a file changes (formatters, linters); their output goes to the agent. */
async function afterChange<T extends ToolOutput>(s: SandboxHandle, ctx: Ctx, path: string, out: T): Promise<T> {
  if (!out.ok) return out;
  const notes = await runAfterChange(s, await projectRules(ctx.scope.projectId), path).catch(() => "");
  return notes ? { ...out, text: `${out.text}${notes}` } : out;
}

export async function globStep(input: { pattern: string; path?: string }, ctx: Ctx) {
  "use step";
  return runTool("glob", input, ctx, (s) => impl.glob(s, input));
}

export async function grepStep(input: { pattern: string; path?: string; glob?: string; literal?: boolean; ignore_case?: boolean }, ctx: Ctx) {
  "use step";
  return runTool("grep", input, ctx, (s) => impl.grep(s, input));
}

export async function runCommandStep(input: { command: string; cwd?: string; timeout_seconds?: number }, ctx: Ctx) {
  "use step";
  if (routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
  return runTool("run_command", input, ctx, async (s) => {
    const rule = blockingRule(await projectRules(ctx.scope.projectId), input.command);
    if (rule) {
      throw new ToolError(
        `Blocked by a project rule (${ruleName(rule)})${rule.event === "before_command" && rule.reason ? `: ${rule.reason}` : ""}. Don't work around it; if the task needs this command, tell the user.`,
      );
    }
    return impl.runCommand(s, input);
  });
}
// Commands can have side effects (npm install); the harness retries transport errors itself.
runCommandStep.maxRetries = 1;

export async function devServerStep(input: { action: "status" | "restart" | "logs" }, ctx: Ctx) {
  "use step";
  return runTool("dev_server", input, ctx, (s) => impl.devServer(s, input));
}

export async function checkPreviewStep(input: Record<string, never>, ctx: Ctx) {
  "use step";
  // Unique per call: some models reuse tool-call ids, and the id matches the browser's markers.
  const checkId = `${stableId(ctx.scope.runId, "check_preview", ctx.toolCallId)}-${Date.now()}`;
  return runTool("check_preview", input, ctx, (s) => impl.checkPreview(s, { projectId: ctx.scope.projectId, fresh: { checkId, requestReload: () => requestPreviewReload(checkId) } }), {
    kind: "verify",
  });
}

export async function verifyStep(input: Record<string, never>, ctx: Ctx) {
  "use step";
  return runTool("verify", input, ctx, (s) => impl.verify(s), { kind: "verify" });
}

export async function researchStep(input: { task: string }, ctx: Ctx) {
  "use step";
  return runSubagent("research", input, ctx);
}
researchStep.maxRetries = 1;

export async function exploreStep(input: { task: string }, ctx: Ctx) {
  "use step";
  return runSubagent("explore", input, ctx);
}
exploreStep.maxRetries = 1;

export async function todosStep(input: { todos: Array<{ content: string; status: string }> }, ctx: Ctx) {
  "use step";
  return runTool(
    "update_todos",
    input,
    ctx,
    async () => {
      const done = input.todos.filter((t) => t.status === "completed").length;
      const active = input.todos.find((t) => t.status === "in_progress");
      return { ok: true, text: `Task list updated: ${done}/${input.todos.length} done${active ? `; now: ${active.content}` : ""}.` };
    },
    { sandbox: false, kind: "system" },
  );
}

export async function skillStep(input: { name: string }, ctx: Ctx) {
  "use step";
  return runTool("skill", input, ctx, async (s) => {
    const { data } = await supabaseAdmin().from("projects").select("settings").eq("id", ctx.scope.projectId).maybeSingle();
    const disabled = ((data?.settings ?? {}) as { disabledSkills?: string[] }).disabledSkills ?? [];
    const found = await loadSkill(s, input.name, disabled);
    if (!found) throw new ToolError(`No skill named "${input.name}" in this project. Use one of the skills listed in your instructions.`);
    const files = found.files.length ? `\n\nOther files in this skill (read them with read_file when the instructions refer to them):\n${found.files.map((f) => `- ${f}`).join("\n")}` : "";
    return { ok: true, text: `# Skill: ${found.skill.name}\n${found.skill.description}\n\n${found.skill.body}${files}`, source: found.source };
  });
}

/** Calls a tool on one of the project's connected MCP servers, from Daedalus's server. */
export async function mcpToolStep(input: { connectionId: string; connection: string; tool: string; args: Record<string, unknown>; readOnly: boolean }, ctx: Ctx) {
  "use step";
  if (!input.readOnly && routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
  return runTool(
    `mcp:${input.connection}.${input.tool}`,
    { tool: input.tool, args: input.args },
    ctx,
    async () => {
      const r = await callConnectionTool(ctx.scope.userId, input.connectionId, input.tool, input.args ?? {});
      if (r.isError) throw new ToolError(`${input.connection} reported an error: ${truncateMiddle(r.text, 4000)}`);
      return { ok: true, text: truncateMiddle(r.text, 12_000), connection: input.connection };
    },
    { sandbox: false },
  );
}
// A connected service may have side effects; don't repeat a call that might have gone through.
mcpToolStep.maxRetries = 1;

/** Proposes a memory; the user keeps or discards it from the card in the chat. */
export async function rememberStep(input: { text: string; scope?: "project" | "me" }, ctx: Ctx) {
  "use step";
  return runTool(
    "remember",
    input,
    ctx,
    async () => {
      const r = await proposeMemory({ userId: ctx.scope.userId, projectId: ctx.scope.projectId, runId: ctx.scope.runId, text: input.text, scope: input.scope ?? "project" });
      const text = r.duplicate
        ? r.status === "kept"
          ? "Already remembered; no need to propose it again."
          : "Already proposed; the user hasn't decided yet."
        : "Proposed to the user. It's used in future turns only if they keep it; carry on with the task.";
      return { ok: true, text, memoryId: r.id, status: r.status };
    },
    { sandbox: false, kind: "system" },
  );
}

export async function askUserStep(input: { questions: Array<{ question: string; options?: string[] }> }, ctx: Ctx) {
  "use step";
  return runTool(
    "ask_user",
    { questions: input.questions.length },
    ctx,
    async () => ({ ok: true, text: "Your questions are shown to the user with answer buttons. Stop here: their answers will arrive as their next message." }),
    { sandbox: false, kind: "system" },
  );
}

export async function proposePlanStep(input: { title: string; summary: string }, ctx: Ctx) {
  "use step";
  return runTool(
    "propose_plan",
    { title: input.title },
    ctx,
    async () => ({ ok: true, text: "Plan shown to the user. Stop here and wait for them to start the build or ask for changes." }),
    { sandbox: false, kind: "system" },
  );
}

/** Only build turns change files; every other route is read-only, whatever the model tries. */
function readOnlyRefusal(scope: RunScope): ToolOutput {
  const e = new ToolError(
    routeOf(scope) === "plan"
      ? "Planning is read-only. Finish with propose_plan, or ask the user with ask_user; building starts after they approve."
      : "This reply is read-only: answer the user's question. If something should change, describe it; they can ask you to make it.",
  );
  return { ok: false, text: `Error: ${e.message}` };
}
