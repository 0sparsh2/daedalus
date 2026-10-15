import "server-only";
import { spawn } from "node:child_process";
import { resolveInRoot, shellQuote, type ExecOptions, type ExecResult, type SandboxFile, type SandboxHandle, type SandboxProvider } from "./types";

/**
 * Docker sandbox provider for local development and CI. One long-lived container per project
 * (`docker run … sleep infinity`); stop/start keeps its filesystem, mirroring Vercel's
 * persistent sandboxes. Not a security boundary for untrusted code: production uses Vercel.
 */

const IMAGE = process.env.DAEDALUS_DOCKER_IMAGE ?? "daedalus-sandbox:latest";
const ROOT = "/workspace/app";
const MAX_OUTPUT = 512 * 1024;

interface RawResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

function docker(args: string[], opts: { input?: Uint8Array | string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      if (outLen < MAX_OUTPUT) out.push(d);
      outLen += d.length;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (errLen < MAX_OUTPUT) err.push(d);
      errLen += d.length;
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs + 10_000)
      : undefined;
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`docker ${args[0]} failed to start: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

class DockerSandbox implements SandboxHandle {
  readonly provider = "docker" as const;
  readonly root = ROOT;
  constructor(readonly name: string) {}

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const started = Date.now();
    const timeoutSec = Math.ceil((opts.timeoutMs ?? 120_000) / 1000);
    const cwd = opts.cwd ? resolveInRoot(ROOT, opts.cwd) : ROOT;
    const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const r = await docker(
      ["exec", "-w", cwd, ...envArgs, this.name, "timeout", "-k", "5", String(timeoutSec), "bash", "-lc", command],
      { timeoutMs: opts.timeoutMs ?? 120_000, signal: opts.signal },
    );
    // `timeout` exits 124 (or 137 after -k) when it kills the command.
    const timedOut = r.timedOut || r.code === 124 || r.code === 137;
    return { exitCode: r.code, stdout: r.stdout.toString("utf8"), stderr: r.stderr.toString("utf8"), durationMs: Date.now() - started, timedOut };
  }

  async spawn(command: string, opts: { cwd?: string; env?: Record<string, string>; logFile?: string } = {}) {
    const cwd = opts.cwd ? resolveInRoot(ROOT, opts.cwd) : ROOT;
    const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const log = opts.logFile ?? "/tmp/daedalus-bg.log";
    const r = await docker(["exec", "-d", "-w", cwd, ...envArgs, this.name, "bash", "-lc", `${command} >> ${shellQuote(log)} 2>&1`]);
    if (r.code !== 0) throw new Error(`Couldn't start "${command}": ${r.stderr.toString()}`);
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const abs = resolveInRoot(ROOT, path);
    const r = await docker(["exec", this.name, "cat", "--", abs]);
    return r.code === 0 ? new Uint8Array(r.stdout) : null;
  }

  async writeFiles(files: SandboxFile[]) {
    const queue = [...files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        const abs = resolveInRoot(ROOT, f.path);
        const r = await docker(["exec", "-i", this.name, "bash", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "_", abs], {
          input: typeof f.content === "string" ? f.content : Buffer.from(f.content),
        });
        if (r.code !== 0) throw new Error(`Couldn't write ${f.path}: ${r.stderr.toString()}`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
  }

  async previewUrl(port: number): Promise<string> {
    const r = await docker(["port", this.name, String(port)]);
    const line = r.stdout.toString().split("\n").find((l) => l.includes(":"));
    if (!line) throw new Error(`Port ${port} is not published for ${this.name}`);
    const hostPort = line.trim().split(":").pop();
    return `http://localhost:${hostPort}`;
  }

  async keepAlive() {}

  async stop() {
    await docker(["stop", "-t", "2", this.name]);
  }
}

async function state(name: string): Promise<"running" | "stopped" | "missing"> {
  const r = await docker(["inspect", "-f", "{{.State.Running}}", name]);
  if (r.code !== 0) return "missing";
  return r.stdout.toString().trim() === "true" ? "running" : "stopped";
}

export const dockerProvider: SandboxProvider = {
  name: "docker",

  async get(name) {
    const s = await state(name);
    if (s === "missing") return null;
    if (s === "stopped") {
      const r = await docker(["start", name]);
      if (r.code !== 0) throw new Error(`Couldn't resume sandbox ${name}: ${r.stderr.toString()}`);
    }
    return new DockerSandbox(name);
  },

  async getOrCreate(name, { projectId, ports }) {
    const existing = await this.get(name);
    if (existing) return { handle: existing, created: false };
    const portArgs = ports.flatMap((p) => ["-p", `127.0.0.1::${p}`]);
    const r = await docker([
      "run", "-d", "--name", name,
      "--label", "daedalus=1", "--label", `daedalus.project=${projectId}`,
      "--memory", "3g", "--cpus", "2", "--pids-limit", "512",
      ...portArgs, IMAGE,
    ]);
    if (r.code !== 0) {
      const msg = r.stderr.toString();
      if (/Unable to find image|pull access denied/i.test(msg)) {
        throw new Error(`Docker image ${IMAGE} not found. Build it with: pnpm sandbox:image`);
      }
      throw new Error(`Couldn't create sandbox: ${msg}`);
    }
    await docker(["exec", name, "bash", "-lc", `mkdir -p ${ROOT}`]);
    return { handle: new DockerSandbox(name), created: true };
  },
};

/** The local image ships the starter app with node_modules installed; copying it is instant. */
export const DOCKER_TEMPLATE_DIR = "/opt/template";
