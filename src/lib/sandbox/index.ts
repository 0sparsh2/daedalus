import "server-only";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { DOCKER_TEMPLATE_DIR, dockerProvider } from "./docker";
import { importRepo, type GithubSource } from "./importer";
import { TEMPLATE_FILES } from "./template-files";
import { sandboxNameFor, type SandboxHandle, type SandboxProvider } from "./types";
import { vercelProvider } from "./vercel";
import { sandboxNetworkPolicy } from "./network";

export * from "./types";

export const PREVIEW_PORT = 5173;
export const DEV_LOG = "/tmp/daedalus-dev.log";
const MARKER = ".daedalus/provisioned";

export function sandboxProvider(name = env.sandboxProvider()): SandboxProvider {
  return name === "vercel" ? vercelProvider : dockerProvider;
}

export type ProvisionEvent = { stage: "sandbox" | "template" | "import" | "install" | "git" | "dev-server" | "ready"; note: string };

/**
 * Brings a project's sandbox to a usable state. Every stage is idempotent, so a retry after a
 * crash (or a durable-step replay) simply continues: create or resume the VM, lay down the
 * starter app, install dependencies, initialise git, start the dev server.
 */
/** Applies the project's sandbox internet allowlist (defaults plus the domains it added). */
export async function applyProjectNetwork(projectId: string, handle: SandboxHandle) {
  if (!handle.applyNetworkPolicy) return "unsupported" as const;
  const { data } = await supabaseAdmin().from("projects").select("settings").eq("id", projectId).maybeSingle();
  const extra = ((data?.settings ?? {}) as { sandboxDomains?: string[] }).sandboxDomains ?? [];
  return handle.applyNetworkPolicy(sandboxNetworkPolicy(extra));
}

export async function ensureProjectSandbox(
  projectId: string,
  onProgress: (e: ProvisionEvent) => void | Promise<void> = () => {},
): Promise<{ handle: SandboxHandle; previewUrl: string; created: boolean }> {
  const provider = sandboxProvider();
  const name = sandboxNameFor(projectId);
  await onProgress({ stage: "sandbox", note: `Starting ${provider.name === "vercel" ? "Vercel Sandbox microVM" : "Docker sandbox"}` });
  const { handle, created } = await provider.getOrCreate(name, { projectId, ports: [PREVIEW_PORT] });
  await handle.keepAlive(20 * 60_000);
  await applyProjectNetwork(projectId, handle);

  const provisioned = await handle.exec(`test -f ${MARKER} && echo yes || echo no`, { timeoutMs: 20_000 });
  if (provisioned.stdout.trim() !== "yes") {
    const { data: project } = await supabaseAdmin().from("projects").select("user_id,source").eq("id", projectId).single();
    const source = (project?.source ?? { type: "template" }) as { type: string } & Partial<GithubSource>;
    if (source.type === "github" && source.repo && project) {
      await onProgress({ stage: "import", note: `Importing ${source.repo}` });
      const previewHost = new URL(await handle.previewUrl(PREVIEW_PORT)).hostname;
      await importRepo(handle, project.user_id, source as GithubSource, previewHost, (note) => Promise.resolve(onProgress({ stage: "import", note })));
      await handle.exec(`mkdir -p .daedalus && date -u +%FT%TZ > ${MARKER}`, { timeoutMs: 15_000 });
    } else {
      await provisionTemplate(handle, provider.name, onProgress);
    }
  }

  await ensureDevServer(handle, onProgress);
  const previewUrl = await handle.previewUrl(PREVIEW_PORT);
  await supabaseAdmin()
    .from("projects")
    .update({ sandbox_provider: provider.name, sandbox_id: name, preview_url: previewUrl, preview_status: "running", status: "ready" })
    .eq("id", projectId);
  await onProgress({ stage: "ready", note: "Preview is live" });
  return { handle, previewUrl, created };
}

async function provisionTemplate(handle: SandboxHandle, provider: "vercel" | "docker", onProgress: (e: ProvisionEvent) => void | Promise<void>) {
  await onProgress({ stage: "template", note: "Laying down the starter app (Vite + React + Tailwind)" });
  if (provider === "docker") {
    const cp = await handle.exec(`cp -a ${DOCKER_TEMPLATE_DIR}/. ${handle.root}/`, { timeoutMs: 60_000 });
    if (cp.exitCode !== 0) throw new Error(`Template copy failed: ${cp.stderr}`);
  } else {
    await handle.writeFiles(TEMPLATE_FILES.map((f) => ({ path: f.path, content: f.content })));
    await onProgress({ stage: "install", note: "Installing dependencies" });
    const install = await handle.exec("npm ci --no-audit --no-fund --loglevel=error", { timeoutMs: 240_000 });
    if (install.exitCode !== 0) throw new Error(`npm ci failed: ${(install.stderr || install.stdout).slice(-2000)}`);
  }
  await onProgress({ stage: "git", note: "Initialising version history" });
  const git = await handle.exec(
    [
      "git init -q -b main 2>/dev/null || git init -q",
      'git config user.name "Daedalus"',
      'git config user.email "agent@daedalus.dev"',
      "git add -A",
      'git commit -q -m "Start from the Daedalus starter app" || true',
      `mkdir -p .daedalus && date -u +%FT%TZ > ${MARKER}`,
    ].join(" && "),
    { timeoutMs: 60_000 },
  );
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr}`);
}

/** Reattach to an already-provisioned project sandbox (resuming it if it was idle). */
export async function attachProjectSandbox(projectId: string): Promise<SandboxHandle> {
  const handle = await sandboxProvider().get(sandboxNameFor(projectId));
  if (handle) {
    await handle.keepAlive(20 * 60_000);
    return handle;
  }
  return (await ensureProjectSandbox(projectId)).handle;
}

export async function devServerUp(handle: SandboxHandle): Promise<boolean> {
  const r = await handle.exec(`curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://127.0.0.1:${PREVIEW_PORT}/ || true`, { timeoutMs: 15_000 });
  return /^[23]\d\d$/.test(r.stdout.trim());
}

export async function devServerLogs(handle: SandboxHandle, lines = 80): Promise<string> {
  const r = await handle.exec(`tail -n ${lines} ${DEV_LOG} 2>/dev/null || true`, { timeoutMs: 15_000 });
  return r.stdout;
}

/**
 * (Re)starts the dev server in its own process group so the whole tree (vite, esbuild, next)
 * can be stopped together. Imported projects run `.daedalus/dev.sh`, generated on import.
 */
export async function restartDevServer(handle: SandboxHandle) {
  await handle.exec(
    `if [ -f /tmp/daedalus-dev.pid ]; then kill -TERM -- -$(cat /tmp/daedalus-dev.pid) 2>/dev/null || true; fi; pkill -f "vite|next dev|react-scripts|astro dev|http.server 5173|serve -l 5173" 2>/dev/null || true; sleep 0.5; : > ${DEV_LOG}`,
    { timeoutMs: 20_000 },
  );
  const start = "if [ -x .daedalus/dev.sh ]; then exec .daedalus/dev.sh; else exec npm run dev; fi";
  await handle.spawn(`command -v setsid >/dev/null && exec setsid bash -c 'echo $$ > /tmp/daedalus-dev.pid; ${start}' || exec bash -c '${start}'`, { logFile: DEV_LOG });
}

export async function ensureDevServer(handle: SandboxHandle, onProgress: (e: ProvisionEvent) => void | Promise<void> = () => {}) {
  if (await devServerUp(handle)) return;
  await onProgress({ stage: "dev-server", note: "Starting the dev server" });
  // Dependencies may be missing after an import or a package.json change.
  const hasModules = await handle.exec("test -d node_modules && echo yes || echo no", { timeoutMs: 15_000 });
  if (hasModules.stdout.trim() !== "yes") {
    const install = await handle.exec("npm install --no-audit --no-fund --loglevel=error", { timeoutMs: 240_000 });
    if (install.exitCode !== 0) throw new Error(`npm install failed: ${(install.stderr || install.stdout).slice(-2000)}`);
  }
  await restartDevServer(handle);
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await devServerUp(handle)) return;
  }
  throw new Error(`Dev server didn't start within 90 s. Last log lines:\n${await devServerLogs(handle, 40)}`);
}
