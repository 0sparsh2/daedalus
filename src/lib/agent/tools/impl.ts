import "server-only";
import { devServerLogs, devServerUp, ensureDevServer, restartDevServer, resolveInRoot, shellQuote, type SandboxHandle } from "@/lib/sandbox";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { applyEdit, miniDiff } from "../edit";
import { ToolError, truncateMiddle } from "../runtime";
import type { ToolOutput } from "../scope";

/**
 * Tool implementations shared by the main agent (as durable steps) and the sub-agents (in
 * process). Paths are always relative to the app root; resolveInRoot refuses escapes.
 */

const IGNORE_GLOBS = ["!node_modules", "!.git", "!dist", "!.daedalus", "!package-lock.json"];
const PROTECTED = [/^node_modules\//, /^\.git\//, /^package-lock\.json$/, /^\.daedalus\//];
const MAX_READ_LINES = 2000;
const MAX_LINE = 2000;

function rel(sbx: SandboxHandle, p: string) {
  const abs = resolveInRoot(sbx.root, p);
  return abs === sbx.root ? "." : abs.slice(sbx.root.length + 1);
}

function assertWritable(path: string) {
  if (PROTECTED.some((re) => re.test(path))) {
    throw new ToolError(`${path} is managed automatically and can't be edited directly. Change package.json and run npm install instead.`);
  }
}

function decode(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return null;
  return new TextDecoder().decode(bytes);
}

export async function listFiles(sbx: SandboxHandle, input: { path?: string; depth?: number }): Promise<ToolOutput> {
  const base = rel(sbx, input.path ?? ".");
  const globs = IGNORE_GLOBS.map((g) => `-g ${shellQuote(g)}`).join(" ");
  const r = await sbx.exec(
    `if command -v rg >/dev/null; then rg --files --hidden ${globs} ${shellQuote(base)}; else find ${shellQuote(base)} -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.daedalus/*' | sed 's#^\\./##'; fi | sort | head -n 600`,
    { timeoutMs: 30_000 },
  );
  const files = r.stdout.split("\n").filter(Boolean);
  const depth = input.depth ?? 6;
  const tree = renderTree(files, depth);
  return { ok: true, text: files.length ? `${files.length} files${files.length >= 600 ? " (first 600)" : ""}:\n${tree}` : "No files found.", count: files.length };
}

function renderTree(files: string[], maxDepth: number): string {
  const lines: string[] = [];
  const seenDirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 0; i < parts.length - 1 && i < maxDepth; i++) {
      const dir = parts.slice(0, i + 1).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        lines.push(`${"  ".repeat(i)}${parts[i]}/`);
      }
    }
    if (parts.length - 1 < maxDepth) lines.push(`${"  ".repeat(parts.length - 1)}${parts[parts.length - 1]}`);
  }
  return lines.join("\n");
}

export async function readFile(sbx: SandboxHandle, input: { path: string; offset?: number; limit?: number }): Promise<ToolOutput> {
  const path = rel(sbx, input.path);
  const bytes = await sbx.readFile(path);
  if (!bytes) throw new ToolError(`File not found: ${path}. Use list_files or glob to find the right path.`);
  const text = decode(bytes);
  if (text === null) return { ok: true, text: `${path} is a binary file (${bytes.length} bytes).`, path, binary: true };
  const all = text.split("\n");
  const offset = Math.max(1, input.offset ?? 1);
  const limit = Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES);
  const slice = all.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((l, i) => `${offset + i}: ${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l}`).join("\n");
  const end = offset - 1 + slice.length;
  const more = end < all.length ? `\n\n[Showing lines ${offset}-${end} of ${all.length}. Use offset=${end + 1} to read more.]` : "";
  return { ok: true, text: `${path}\n${numbered}${more}`, path, lines: slice.length, totalLines: all.length };
}

export async function writeFile(sbx: SandboxHandle, input: { path: string; content: string }): Promise<ToolOutput> {
  const path = rel(sbx, input.path);
  assertWritable(path);
  const before = await sbx.readFile(path);
  const prev = before ? (decode(before) ?? "") : null;
  await sbx.writeFiles([{ path, content: input.content }]);
  const d = miniDiff(prev ?? "", input.content);
  const lines = input.content.split("\n").length;
  return {
    ok: true,
    text: prev === null ? `Created ${path} (${lines} lines).` : `Rewrote ${path} (+${d.added} −${d.removed}).`,
    path,
    created: prev === null,
    added: prev === null ? lines : d.added,
    removed: prev === null ? 0 : d.removed,
    diff: prev === null ? undefined : d.diff,
  };
}

export async function editFile(sbx: SandboxHandle, input: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<ToolOutput> {
  const path = rel(sbx, input.path);
  assertWritable(path);
  const bytes = await sbx.readFile(path);
  if (!bytes) throw new ToolError(`File not found: ${path}. To create a new file use write_file.`);
  const original = decode(bytes);
  if (original === null) throw new ToolError(`${path} is binary and can't be edited as text.`);
  const r = applyEdit(original, input.old_string, input.new_string, input.replace_all ?? false);
  if (!r.ok) throw new ToolError(`${path}: ${r.error}`);
  await sbx.writeFiles([{ path, content: r.content }]);
  const d = miniDiff(original, r.content);
  const note = r.tier === "exact" ? "" : ` (matched after ${r.tier === "unicode" ? "normalising quotes/dashes" : r.tier === "trim-end" ? "ignoring trailing spaces" : "adjusting indentation"})`;
  return {
    ok: true,
    text: `Edited ${path}: ${r.replacements} replacement${r.replacements === 1 ? "" : "s"}, +${d.added} −${d.removed}${note}.\n${d.diff}`,
    path,
    added: d.added,
    removed: d.removed,
    diff: d.diff,
  };
}

export async function deleteFile(sbx: SandboxHandle, input: { path: string }): Promise<ToolOutput> {
  const path = rel(sbx, input.path);
  assertWritable(path);
  if (path === ".") throw new ToolError("Refusing to delete the project root.");
  const r = await sbx.exec(`test -e ${shellQuote(path)} && rm -rf -- ${shellQuote(path)} && echo deleted || echo missing`, { timeoutMs: 30_000 });
  if (r.stdout.includes("missing")) throw new ToolError(`Nothing to delete at ${path}.`);
  return { ok: true, text: `Deleted ${path}.`, path };
}

export async function glob(sbx: SandboxHandle, input: { pattern: string; path?: string }): Promise<ToolOutput> {
  const base = rel(sbx, input.path ?? ".");
  const globs = IGNORE_GLOBS.map((g) => `-g ${shellQuote(g)}`).join(" ");
  const r = await sbx.exec(
    `if command -v rg >/dev/null; then rg --files --hidden ${globs} -g ${shellQuote(input.pattern)} ${shellQuote(base)}; else shopt -s globstar nullglob; cd ${shellQuote(base)} && printf '%s\\n' ${input.pattern.replace(/[^\w*?./{},-]/g, "")}; fi | grep -v node_modules | sort | head -n 300`,
    { timeoutMs: 30_000 },
  );
  const files = r.stdout.split("\n").filter(Boolean);
  return { ok: true, text: files.length ? files.join("\n") : `No files match ${input.pattern}.`, count: files.length };
}

export async function grep(sbx: SandboxHandle, input: { pattern: string; path?: string; glob?: string; literal?: boolean; ignore_case?: boolean }): Promise<ToolOutput> {
  const base = rel(sbx, input.path ?? ".");
  const flags = [input.literal ? "-F" : "", input.ignore_case ? "-i" : ""].filter(Boolean).join(" ");
  const globs = [...IGNORE_GLOBS, ...(input.glob ? [input.glob] : [])].map((g) => `-g ${shellQuote(g)}`).join(" ");
  const grepFlags = [input.literal ? "-F" : "-E", input.ignore_case ? "-i" : ""].filter(Boolean).join(" ");
  const r = await sbx.exec(
    `if command -v rg >/dev/null; then rg -n --no-heading --color never --max-columns 300 ${flags} ${globs} -e ${shellQuote(input.pattern)} ${shellQuote(base)}; else grep -rnI ${grepFlags} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -e ${shellQuote(input.pattern)} ${shellQuote(base)}; fi | head -n 200`,
    { timeoutMs: 30_000 },
  );
  if (r.exitCode > 1 && r.stderr) throw new ToolError(`Search failed: ${r.stderr.slice(0, 500)}`);
  const lines = r.stdout.split("\n").filter(Boolean);
  return { ok: true, text: lines.length ? `${lines.length}${lines.length >= 200 ? "+" : ""} matches:\n${lines.join("\n")}` : `No matches for ${input.pattern}.`, count: lines.length };
}

const DEV_SERVER_CMD = /(^|[;&|]\s*)(npm\s+(run\s+)?(dev|start)|pnpm\s+(run\s+)?dev|yarn\s+dev|npx\s+vite(\s|$)(?!build)|vite(\s|$)(?!build|preview))/;
const BLOCKED: Array<[RegExp, string]> = [
  [/\brm\s+-rf?\s+(\/|~|\$HOME)(\s|$)/, "Deleting the filesystem root or home directory is not allowed."],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "Fork bombs are not allowed."],
  [/\bgit\s+push\b/, "Pushing is done with the GitHub button in Daedalus, not from the sandbox."],
  [/\b(shutdown|reboot|halt)\b/, "Power commands are not allowed."],
];

export async function runCommand(sbx: SandboxHandle, input: { command: string; cwd?: string; timeout_seconds?: number }): Promise<ToolOutput> {
  const command = input.command.trim();
  if (DEV_SERVER_CMD.test(command)) {
    throw new ToolError("The dev server is already running and managed for you (port 5173, hot reload). Use dev_server with action \"restart\" if it needs a restart.");
  }
  for (const [re, why] of BLOCKED) if (re.test(command)) throw new ToolError(why);
  const timeoutMs = Math.min(Math.max(input.timeout_seconds ?? 120, 5), 240) * 1000;
  const r = await sbx.exec(command, { cwd: input.cwd, timeoutMs, env: { CI: "1", FORCE_COLOR: "0", npm_config_yes: "true" } });
  const out = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n--- stderr ---\n");
  const status = r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exit code ${r.exitCode}`;
  // Installing packages changes what the dev server can resolve; restart it so new deps load.
  if (/\bnpm\s+(i|install|add|uninstall|remove)\b/.test(command) && r.exitCode === 0) {
    await restartDevServer(sbx);
  }
  return {
    ok: r.exitCode === 0 && !r.timedOut,
    text: `$ ${command}\n${status} (${(r.durationMs / 1000).toFixed(1)} s)\n${truncateMiddle(out || "(no output)", 10_000)}`,
    command,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
  };
}

export async function devServer(sbx: SandboxHandle, input: { action: "status" | "restart" | "logs" }): Promise<ToolOutput> {
  if (input.action === "restart") {
    await restartDevServer(sbx);
    await ensureDevServer(sbx);
    return { ok: true, text: "Dev server restarted and responding on port 5173.", status: "running" };
  }
  const up = await devServerUp(sbx);
  const logs = await devServerLogs(sbx, input.action === "logs" ? 120 : 30);
  return { ok: true, text: `Dev server is ${up ? "running" : "NOT responding"}.\nRecent log:\n${truncateMiddle(logs || "(empty)", 8000)}`, status: up ? "running" : "down" };
}

const PROBE = `const base="http://127.0.0.1:5173";const seen=new Set();const errors=[];const queue=["/"];
const skip=u=>!u.startsWith("/")||/^\\/(node_modules|@vite|@react-refresh|@id|@fs)\\b/.test(u)||u.startsWith("/__daedalus");
while(queue.length&&seen.size<250){const p=queue.shift();const k=p.split("?")[0];if(seen.has(k))continue;seen.add(k);
let r,t;try{r=await fetch(base+p,{headers:{accept:p==="/"?"text/html":"*/*"}});t=await r.text();}catch(e){errors.push({path:p,error:String(e)});continue;}
if(r.status>=400){errors.push({path:p,status:r.status,error:t.slice(0,1500)});continue;}
const re=p==="/"?/<script[^>]+src="([^"]+)"/g:/(?:import|export)\\s*(?:[^'";]*?from\\s*)?["']([^"']+)["']|import\\(\\s*["']([^"']+)["']\\s*\\)/g;
for(const m of t.matchAll(re)){const u=m[1]||m[2];if(u&&!skip(u))queue.push(u);}}
console.log(JSON.stringify({checked:seen.size,errors}));`;

/**
 * Checks the running app without a browser: crawls Vite's module graph from index.html
 * (compile and import errors surface as HTTP 500s), reads the dev-server log, and includes
 * runtime errors the preview bridge reported from the user's browser since the last change.
 */
export async function checkPreview(sbx: SandboxHandle, input: { projectId: string; since?: string }): Promise<ToolOutput> {
  await ensureDevServer(sbx);
  await sbx.writeFiles([{ path: ".daedalus/probe.mjs", content: PROBE }]);
  const r = await sbx.exec("node .daedalus/probe.mjs", { timeoutMs: 60_000 });
  let probe: { checked: number; errors: Array<{ path: string; status?: number; error: string }> } = { checked: 0, errors: [] };
  try {
    probe = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    probe.errors.push({ path: "/", error: `Probe failed: ${(r.stderr || r.stdout).slice(0, 800)}` });
  }
  const logs = await devServerLogs(sbx, 60);
  const logErrors = logs
    .split("\n")
    .filter((l) => /error|failed|cannot find|unexpected/i.test(l) && !/hmr update/i.test(l))
    .slice(-12);
  const since = input.since ?? new Date(Date.now() - 10 * 60_000).toISOString();
  const { data: runtime } = await supabaseAdmin()
    .from("preview_errors")
    .select("kind,message,stack,created_at")
    .eq("project_id", input.projectId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(8);
  const problems: string[] = [];
  for (const e of probe.errors) problems.push(`Module ${e.path}${e.status ? ` (HTTP ${e.status})` : ""}: ${cleanViteError(e.error)}`);
  for (const e of runtime ?? []) problems.push(`Browser ${e.kind}: ${e.message}${e.stack ? `\n${String(e.stack).split("\n").slice(0, 4).join("\n")}` : ""}`);
  const ok = problems.length === 0;
  const text = ok
    ? `Preview is healthy: ${probe.checked} modules compiled, no runtime errors reported.${logErrors.length ? `\nDev-server log mentions:\n${logErrors.join("\n")}` : ""}`
    : `Preview has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((p, i) => `${i + 1}. ${p}`).join("\n\n")}`;
  return { ok, text: truncateMiddle(text, 9000), modules: probe.checked, problems: problems.length };
}

function cleanViteError(s: string): string {
  try {
    const j = JSON.parse(s);
    if (j?.message) return `${j.message}${j.loc ? ` at ${j.loc.file ?? ""}:${j.loc.line}:${j.loc.column}` : ""}`;
  } catch {}
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
}

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  code: string;
  message: string;
}

/** Type-checks and builds the app. The harness also runs this before a build run may finish. */
export async function verify(sbx: SandboxHandle): Promise<ToolOutput & { diagnostics: Diagnostic[] }> {
  const tc = await sbx.exec("if [ -f tsconfig.json ]; then npx --no-install tsc --noEmit -p tsconfig.json --pretty false; else echo 'no tsconfig.json; skipped'; fi", { timeoutMs: 150_000 });
  const diagnostics: Diagnostic[] = [];
  for (const line of `${tc.stdout}\n${tc.stderr}`.split("\n")) {
    const m = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (m) diagnostics.push({ file: m[1], line: +m[2], col: +m[3], code: m[4], message: m[5] });
  }
  const typecheckOk = tc.exitCode === 0;
  const build = await sbx.exec("npm run build --silent 2>&1 | tail -n 60", { timeoutMs: 180_000 });
  const buildFailed = /error|failed|could not resolve/i.test(build.stdout) && !/built in/i.test(build.stdout);
  const ok = typecheckOk && !buildFailed;
  const parts: string[] = [];
  parts.push(typecheckOk ? "Type check: passed." : `Type check: ${diagnostics.length || "some"} error(s).`);
  if (!typecheckOk) {
    parts.push(
      diagnostics.length
        ? diagnostics.slice(0, 25).map((d) => `${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`).join("\n")
        : truncateMiddle(`${tc.stdout}\n${tc.stderr}`, 4000),
    );
  }
  parts.push(buildFailed ? `Build: failed.\n${truncateMiddle(build.stdout, 5000)}` : "Build: passed.");
  return { ok, text: parts.join("\n"), diagnostics, typecheckOk, buildOk: !buildFailed };
}

/** Commits the run's changes in the sandbox repo and returns the checkpoint, if anything changed. */
export async function commitCheckpoint(sbx: SandboxHandle, message: string): Promise<{ sha: string; files: number } | null> {
  const status = await sbx.exec("git status --porcelain | wc -l", { timeoutMs: 30_000 });
  const files = Number(status.stdout.trim()) || 0;
  if (files === 0) return null;
  const r = await sbx.exec(`git add -A && git commit -q -m ${shellQuote(message.slice(0, 200))} && git rev-parse HEAD`, { timeoutMs: 60_000 });
  if (r.exitCode !== 0) return null;
  return { sha: r.stdout.trim().split("\n").pop() ?? "", files };
}
