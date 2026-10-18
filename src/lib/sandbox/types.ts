/**
 * The sandbox seam. Everything the harness does to a user's app (files, commands, dev
 * server, preview URL) goes through SandboxHandle, so the runtime can be Vercel Sandbox
 * (Firecracker microVMs, production) or Docker (local development and tests) without the
 * agent, tools or UI knowing which.
 */

export type SandboxProviderName = "vercel" | "docker";

export interface ExecOptions {
  /** Directory relative to the app root, or absolute. Defaults to the app root. */
  cwd?: string;
  env?: Record<string, string>;
  /** Hard limit; the process tree is killed when it is reached. Default 120 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface SandboxFile {
  /** Path relative to the app root (or absolute inside the sandbox). */
  path: string;
  content: string | Uint8Array;
}

export interface SandboxHandle {
  readonly provider: SandboxProviderName;
  /** Stable name, e.g. `dd-<projectId>`; enough to reattach from any process. */
  readonly name: string;
  /** Absolute path of the app root inside the sandbox. */
  readonly root: string;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Starts a long-running process and returns immediately (dev servers). */
  spawn(command: string, opts?: { cwd?: string; env?: Record<string, string>; logFile?: string }): Promise<void>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFiles(files: SandboxFile[]): Promise<void>;
  /** Public URL for a port exposed by the sandbox. */
  previewUrl(port: number): Promise<string>;
  /** Keep the sandbox alive while an agent is working (no-op where not needed). */
  keepAlive(ms: number): Promise<void>;
  /**
   * Limits the sandbox's internet access to these domains (lib/sandbox/network.ts). Returns
   * whether it changed anything; "unsupported" where the provider can't enforce it (Docker).
   */
  applyNetworkPolicy?(policy: { allow: string[] } | "allow-all"): Promise<"applied" | "unchanged" | "unsupported">;
  stop(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: SandboxProviderName;
  /** Returns the project's sandbox, creating it if needed (an empty root) or resuming it. */
  getOrCreate(name: string, opts: { projectId: string; ports: number[] }): Promise<{ handle: SandboxHandle; created: boolean }>;
  /** Reattaches to an existing sandbox; null if it no longer exists. */
  get(name: string): Promise<SandboxHandle | null>;
}

export function sandboxNameFor(projectId: string) {
  return `dd-${projectId}`;
}

/** Resolves a model-supplied path against the app root and refuses escapes (../, absolute paths outside). */
export function resolveInRoot(root: string, p: string): string {
  const cleaned = p.replace(/^\.\/+/, "").trim();
  const abs = cleaned.startsWith("/") ? cleaned : `${root}/${cleaned}`;
  const parts: string[] = [];
  for (const seg of abs.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const normalized = `/${parts.join("/")}`;
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`Path "${p}" is outside the project. Use paths relative to the project root.`);
  }
  return normalized;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
