import "server-only";
import { requestPreviewReload } from "../emit";
import { runSubagent } from "../subagents";
import { runTool, stableId, ToolError } from "../runtime";
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
  return runTool("write_file", { path: input.path, bytes: input.content.length }, ctx, (s) => impl.writeFile(s, input));
}

export async function editFileStep(input: { path: string; old_string: string; new_string: string; replace_all?: boolean }, ctx: Ctx) {
  "use step";
  if (routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
  return runTool("edit_file", input, ctx, (s) => impl.editFile(s, input));
}

export async function deleteFileStep(input: { path: string }, ctx: Ctx) {
  "use step";
  if (routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
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
  if (routeOf(ctx.scope) !== "build") return readOnlyRefusal(ctx.scope);
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
