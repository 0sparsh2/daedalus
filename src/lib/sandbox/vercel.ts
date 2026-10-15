import "server-only";
import { Sandbox } from "@vercel/sandbox";
import { resolveInRoot, shellQuote, type ExecOptions, type ExecResult, type SandboxFile, type SandboxHandle, type SandboxProvider } from "./types";

/**
 * Vercel Sandbox provider (production). Each project gets one named, persistent Firecracker
 * microVM: when idle it stops and snapshots its filesystem; the next SDK call resumes it.
 * Auth: OIDC automatically on Vercel; locally `vercel env pull`, or VERCEL_TOKEN + team/project.
 */

const ROOT = "/vercel/sandbox";
const SESSION_TIMEOUT_MS = Number(process.env.SANDBOX_SESSION_TIMEOUT_MS ?? 30 * 60_000);

function credentials() {
  const token = process.env.VERCEL_SANDBOX_TOKEN ?? process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_SANDBOX_TEAM_ID ?? process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_SANDBOX_PROJECT_ID ?? process.env.VERCEL_PROJECT_ID;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

class VercelSandbox implements SandboxHandle {
  readonly provider = "vercel" as const;
  readonly root = ROOT;
  constructor(
    readonly name: string,
    private sbx: Sandbox,
  ) {}

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timeoutSec = Math.ceil(timeoutMs / 1000);
    const signals = [AbortSignal.timeout(timeoutMs + 15_000), ...(opts.signal ? [opts.signal] : [])];
    try {
      const r = await this.sbx.runCommand({
        cmd: "timeout",
        args: ["-k", "5", String(timeoutSec), "bash", "-lc", command],
        cwd: opts.cwd ? resolveInRoot(ROOT, opts.cwd) : ROOT,
        env: opts.env,
        signal: AbortSignal.any(signals),
      });
      const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
      const timedOut = r.exitCode === 124 || r.exitCode === 137;
      return { exitCode: r.exitCode ?? 1, stdout, stderr, durationMs: Date.now() - started, timedOut };
    } catch (err) {
      if ((err as Error).name === "AbortError" || (err as Error).name === "TimeoutError") {
        return { exitCode: 124, stdout: "", stderr: `Command aborted after ${Date.now() - started} ms`, durationMs: Date.now() - started, timedOut: true };
      }
      throw err;
    }
  }

  async spawn(command: string, opts: { cwd?: string; env?: Record<string, string>; logFile?: string } = {}) {
    const log = opts.logFile ?? "/tmp/daedalus-bg.log";
    await this.sbx.runCommand({
      cmd: "bash",
      args: ["-lc", `( ${command} ) >> ${shellQuote(log)} 2>&1`],
      cwd: opts.cwd ? resolveInRoot(ROOT, opts.cwd) : ROOT,
      env: opts.env,
      detached: true,
    });
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const buf = await this.sbx.readFileToBuffer({ path: resolveInRoot(ROOT, path) });
    return buf ? new Uint8Array(buf) : null;
  }

  async writeFiles(files: SandboxFile[]) {
    // One call per batch keeps round trips low; the SDK creates parent directories.
    for (let i = 0; i < files.length; i += 50) {
      await this.sbx.writeFiles(
        files.slice(i, i + 50).map((f) => ({
          path: resolveInRoot(ROOT, f.path),
          content: typeof f.content === "string" ? Buffer.from(f.content, "utf8") : Buffer.from(f.content),
        })),
      );
    }
  }

  async previewUrl(port: number) {
    return this.sbx.domain(port);
  }

  async keepAlive(ms: number) {
    const left = this.sbx.expiresAt ? this.sbx.expiresAt.getTime() - Date.now() : 0;
    if (left < ms) await this.sbx.extendTimeout(ms - Math.max(left, 0)).catch(() => {});
  }

  async stop() {
    await this.sbx.stop();
  }
}

export const vercelProvider: SandboxProvider = {
  name: "vercel",

  async get(name) {
    try {
      const sbx = await Sandbox.get({ name, resume: true, ...credentials() });
      return new VercelSandbox(name, sbx);
    } catch (err) {
      if (/not.?found|404/i.test((err as Error).message)) return null;
      throw err;
    }
  },

  async getOrCreate(name, { projectId, ports }) {
    let created = false;
    const templateSnapshot = process.env.VERCEL_TEMPLATE_SNAPSHOT_ID;
    const common = {
      name,
      resume: true,
      ports,
      timeout: SESSION_TIMEOUT_MS,
      resources: { vcpus: 2 },
      env: { DAEDALUS_PREVIEW_HTTPS: "1", CI: "1", npm_config_update_notifier: "false" },
      tags: { app: "daedalus", project: projectId },
      keepLastSnapshots: { count: 3 },
      snapshotExpiration: 14 * 24 * 60 * 60 * 1000,
      onCreate: async () => {
        created = true;
      },
      ...credentials(),
    };
    const sbx = templateSnapshot
      ? await Sandbox.getOrCreate({ ...common, source: { type: "snapshot", snapshotId: templateSnapshot } })
      : await Sandbox.getOrCreate(common);
    return { handle: new VercelSandbox(name, sbx), created };
  },
};
