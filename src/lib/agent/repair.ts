/**
 * Tool-call repair for models that drift from the schema (common with open models): tool
 * names borrowed from other harnesses (bash, str_replace, TodoWrite…), camelCase keys,
 * markdown-fenced or trailing-comma JSON, misspelt keys, JSON-encoded arrays and objects,
 * and stray extra fields. Fixes are checked against the tool's own JSON schema. A repaired
 * call is executed normally; anything we can't fix goes back to the model as an error so it
 * can retry.
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

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
}

/** The tool's input JSON schema, from an AI SDK schema object or a plain JSON schema. */
export function schemaOf(tool: unknown): JsonSchema | undefined {
  const s = (tool as { inputSchema?: unknown } | undefined)?.inputSchema;
  if (!s || typeof s !== "object") return undefined;
  const js = (s as { jsonSchema?: unknown }).jsonSchema ?? s;
  return js && typeof js === "object" && "properties" in js ? (js as JsonSchema) : undefined;
}

const typesOf = (s: JsonSchema | undefined): string[] => (s?.type === undefined ? [] : Array.isArray(s.type) ? s.type : [s.type]);
const squash = (k: string) => k.toLowerCase().replace(/[_-]/g, "");

/** "tos" ~ "todos", "filepath" ~ "path"-style near misses: same letters in order, most of them. */
function similar(given: string, known: string): boolean {
  const a = squash(given);
  const b = squash(known);
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 2 || short.length / long.length < 0.5) return false;
  if (long.startsWith(short) || long.endsWith(short)) return true;
  let i = 0;
  for (const ch of long) if (ch === short[i]) i++;
  return i === short.length;
}

/** Decodes a JSON-encoded value when the schema wants an array, object, number or boolean. */
function coerce(v: unknown, s: JsonSchema | undefined): { ok: boolean; value: unknown } {
  const want = typesOf(s);
  const fits = (x: unknown) =>
    !want.length ||
    want.some((t) => (t === "array" ? Array.isArray(x) : t === "object" ? !!x && typeof x === "object" && !Array.isArray(x) : t === "integer" ? Number.isInteger(x) : typeof x === t));
  if (fits(v)) return { ok: true, value: v };
  if (typeof v !== "string") return { ok: false, value: v };
  const t = v.trim();
  try {
    if ((want.includes("array") && t.startsWith("[")) || (want.includes("object") && t.startsWith("{"))) {
      const parsed = JSON.parse(t);
      if (fits(parsed)) return { ok: true, value: parsed };
    }
  } catch {
    // not JSON after all
  }
  if ((want.includes("number") || want.includes("integer")) && t !== "" && Number.isFinite(Number(t)) && fits(Number(t))) return { ok: true, value: Number(t) };
  if (want.includes("boolean") && (t === "true" || t === "false")) return { ok: true, value: t === "true" };
  return { ok: false, value: v };
}

/**
 * Fits a call's input to the tool's schema: renames an unknown key to the one missing key
 * it resembles (or to the only missing required key, when its value has the right type),
 * decodes JSON-encoded values, and drops leftover keys the schema forbids.
 */
export function fitToSchema(input: Record<string, unknown>, schema: JsonSchema | undefined): Record<string, unknown> {
  const props = schema?.properties;
  if (!props) return input;
  const out: Record<string, unknown> = { ...input };
  const missing = () => Object.keys(props).filter((k) => !(k in out));
  const unknown = () => Object.keys(out).filter((k) => !(k in props));
  for (const k of unknown()) {
    const candidates = missing().filter((m) => similar(k, m));
    if (candidates.length === 1) {
      out[candidates[0]] = out[k];
      delete out[k];
    }
  }
  const leftover = unknown();
  const missingRequired = missing().filter((k) => schema.required?.includes(k));
  if (leftover.length === 1 && missingRequired.length === 1) {
    const c = coerce(out[leftover[0]], props[missingRequired[0]]);
    if (c.ok) {
      out[missingRequired[0]] = c.value;
      delete out[leftover[0]];
    }
  }
  for (const k of Object.keys(out)) {
    if (k in props) out[k] = fitNested(coerce(out[k], props[k]).value, props[k]);
    else if (schema.additionalProperties === false) delete out[k];
  }
  return out;
}

/** Applies fitToSchema inside objects and arrays of objects (e.g. each todo item). */
function fitNested(v: unknown, s: JsonSchema | undefined): unknown {
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  if (Array.isArray(v) && s?.items?.properties) return v.map((item) => (isObj(item) ? fitToSchema(item, s.items) : item));
  if (isObj(v) && s?.properties) return fitToSchema(v, s);
  return v;
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
  const input = fitToSchema(normalizeKeys(toolName, parsed), schemaOf(tools[toolName]));
  const repaired = JSON.stringify(input);
  if (toolName === toolCall.toolName && repaired === toolCall.input) return null;
  return { type: "tool-call" as const, toolCallId: toolCall.toolCallId, toolName, input: repaired };
}
