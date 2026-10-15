import "server-only";
import { runSubagent } from "../subagents";
import { runTool, ToolError } from "../runtime";
import type { RunScope, ToolOutput } from "../scope";
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
  if (ctx.scope.mode === "plan") return planModeRefusal();
  // Keep the event log lean: the content is in the model's tool call already.
  return runTool("write_file", { path: input.path, bytes: input.content.length }, ctx, (s) => impl.writeFile(s, input));
}

export async function editFileStep(input: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx: Ctx) {
  "use step";
  if (ctx.scope.mode === "plan") return planModeRefusal();
  return runTool("edit_file", input, ctx, (s) => impl.editFile(s, input));
}

export async function deleteFileStep(input: { path: string }, ctx: Ctx) {
  "use step";
  if (ctx.scope.mode === "plan") return planModeRefusal();
  return runTool("delete_file", input, ctx, (s) => impl.deleteFile(s, input));
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
  if (ctx.scope.mode === "plan") return planModeRefusal();
  return runTool("run_command", input, ctx, (s) => impl.runCommand(s, input));
}
// Commands can have side effects (npm install); the harness retries transport errors itself.
runCommandStep.maxRetries = 1;

export async function devServerStep(input: { action: "status" | "restart" | "logs" }, ctx: Ctx) {
  "use step";
  return runTool("dev_server", input, ctx, (s) => impl.devServer(s, input));
}

export async function checkPreviewStep(input: Record<string, never>, ctx: Ctx) {
  "use step";
  return runTool("check_preview", input, ctx, (s) => impl.checkPreview(s, { projectId: ctx.scope.projectId }), { kind: "verify" });
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

function planModeRefusal(): ToolOutput {
  const e = new ToolError("Planning mode is read-only. Finish the plan with propose_plan; building starts after the user approves it.");
  return { ok: false, text: `Error: ${e.message}` };
}
