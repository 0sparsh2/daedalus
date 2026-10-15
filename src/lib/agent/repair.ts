/**
 * Tool-call repair for models that drift from the schema (common with open models): tool
 * names borrowed from other harnesses (bash, str_replace, TodoWrite…), camelCase keys,
 * markdown-fenced or trailing-comma JSON. A repaired call is executed normally; anything we
 * can't fix goes back to the model as an error so it can retry.
 */

const TOOL_ALIASES: Record<string, string> = {
  bash: "run_command",
  shell: "run_command",
  terminal: "run_command",
  exec: "run_command",
  execute_command: "run_command",
  run: "run_command",
  str_replace: "edit_file",
  str_replace_editor: "edit_file",
  edit: "edit_file",
  replace: "edit_file",
  apply_edit: "edit_file",
  write: "write_file",
  create_file: "write_file",
  save_file: "write_file",
  read: "read_file",
  view: "read_file",
  cat: "read_file",
  open_file: "read_file",
  ls: "list_files",
  list: "list_files",
  list_dir: "list_files",
  list_directory: "list_files",
  search: "grep",
  search_files: "grep",
  ripgrep: "grep",
  find: "glob",
  find_files: "glob",
  todowrite: "update_todos",
  todo_write: "update_todos",
  update_plan: "update_todos",
  todo: "update_todos",
  webresearch: "research",
  web_search: "research",
  task: "explore",
  remove_file: "delete_file",
  rm: "delete_file",
};

const KEY_ALIASES: Record<string, string> = {
  file_path: "path",
  filePath: "path",
  filepath: "path",
  filename: "path",
  file: "path",
  target_file: "path",
  oldString: "old_string",
  old_str: "old_string",
  old: "old_string",
  search: "old_string",
  newString: "new_string",
  new_str: "new_string",
  new: "new_string",
  replaceAll: "replace_all",
  cmd: "command",
  script: "command",
  timeout: "timeout_seconds",
  text: "content",
  contents: "content",
  file_text: "content",
  regex: "pattern",
  query: "pattern",
};

export function parseLooseJson(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  const attempts = [s, s.replace(/,\s*([}\]])/g, "$1")];
  const brace = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (brace >= 0 && last > brace) attempts.push(s.slice(brace, last + 1).replace(/,\s*([}\]])/g, "$1"));
  for (const a of attempts) {
    try {
      let v: unknown = JSON.parse(a);
      if (typeof v === "string") v = JSON.parse(v);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next strategy
    }
  }
  return null;
}

export function normalizeKeys(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    let key = KEY_ALIASES[k] ?? k;
    // "query" means a search pattern for grep but a question for research.
    if ((toolName === "research" || toolName === "explore") && (k === "query" || k === "question" || k === "prompt")) key = "task";
    if (toolName === "write_file" && k === "text") key = "content";
    if (!(key in out)) out[key] = v;
  }
  if (toolName === "run_command" && Array.isArray(out.command)) out.command = (out.command as unknown[]).join(" ");
  if (toolName === "run_command" && typeof out.timeout_seconds === "number" && out.timeout_seconds > 1000) {
    out.timeout_seconds = Math.round((out.timeout_seconds as number) / 1000);
  }
  return out;
}

interface RepairArgs {
  toolCall: { toolCallId: string; toolName: string; input: string; [k: string]: unknown };
  tools: Record<string, unknown>;
  error: unknown;
}

export async function repairToolCall({ toolCall, tools, error }: RepairArgs) {
  "use step";
  const errName = (error as { name?: string })?.name ?? "";
  let toolName = toolCall.toolName;
  if (errName.includes("NoSuchTool") || !(toolName in tools)) {
    const key = toolName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const mapped = TOOL_ALIASES[key] ?? TOOL_ALIASES[key.replace(/_/g, "")];
    if (!mapped || !(mapped in tools)) return null;
    toolName = mapped;
  }
  const parsed = parseLooseJson(toolCall.input);
  if (!parsed) return null;
  const input = normalizeKeys(toolName, parsed);
  const repaired = JSON.stringify(input);
  if (toolName === toolCall.toolName && repaired === toolCall.input) return null;
  return { type: "tool-call" as const, toolCallId: toolCall.toolCallId, toolName, input: repaired };
}
