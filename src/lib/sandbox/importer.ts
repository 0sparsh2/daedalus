import "server-only";
import { getConnection } from "@/lib/github";
import { HttpError } from "@/lib/http";
import { shellQuote, type SandboxHandle } from "./types";

/**
 * Importing an existing GitHub repository into a project's sandbox. The tarball is fetched on
 * the server (with the user's GitHub token when the repo is private), so the token never
 * enters the sandbox; the sandbox only receives the archive. Then: extract, install with the
 * repo's package manager, detect how to start its dev server on the preview port, and start
 * a fresh git history so every Daedalus run is a restorable version.
 */

export interface GithubSource {
  type: "github";
  repo: string; // owner/name
  ref?: string;
}

export function parseRepoUrl(input: string): { repo: string; ref?: string } | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/$/, "");
  const m =
    s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/(.+))?$/i) ?? s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, ref: m[3] };
}

async function gh(path: string, token?: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
}

export interface RepoInfo {
  repo: string;
  ref: string;
  description: string | null;
  canPush: boolean;
  private: boolean;
  sizeKb: number;
}

/** Checks the repo exists and is reachable with the user's access; used before creating a project. */
export async function lookupRepo(userId: string, repo: string, ref?: string): Promise<RepoInfo> {
  const conn = await getConnection(userId).catch(() => null);
  const res = await gh(`/repos/${repo}`, conn?.token);
  if (res.status === 404) {
    throw new HttpError(404, conn ? `Couldn't find ${repo}, or your GitHub account can't see it.` : `Couldn't find ${repo}. If it's private, connect GitHub first.`, "repo_not_found");
  }
  if (res.status === 403) throw new HttpError(429, "GitHub rate limit reached. Connect GitHub or try again later.", "github_rate_limited");
  if (!res.ok) throw new HttpError(502, `GitHub returned ${res.status}`, "github_error");
  const j = (await res.json()) as { full_name: string; default_branch: string; description: string | null; private: boolean; size: number; permissions?: { push?: boolean } };
  if (j.size > 400_000) throw new HttpError(413, `${j.full_name} is too large to import (${Math.round(j.size / 1024)} MB).`, "repo_too_large");
  return { repo: j.full_name, ref: ref ?? j.default_branch, description: j.description, canPush: Boolean(j.permissions?.push), private: j.private, sizeKb: j.size };
}

/** Writes the repository into the sandbox root and prepares it to run. Idempotent via the caller's marker. */
export async function importRepo(sandbox: SandboxHandle, userId: string, source: GithubSource, previewHost: string | null, log: (note: string) => Promise<void>) {
  const conn = await getConnection(userId).catch(() => null);
  const ref = source.ref ?? "HEAD";
  await log(`Downloading ${source.repo}`);
  const res = await gh(`/repos/${source.repo}/tarball/${encodeURIComponent(ref)}`, conn?.token);
  if (!res.ok) throw new Error(`Couldn't download ${source.repo}@${ref}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > 150 * 1024 * 1024) throw new Error("The repository archive is larger than 150 MB.");

  await sandbox.writeFiles([{ path: ".daedalus/import.tgz", content: buf }]);
  const extract = await sandbox.exec(
    "tar -xzf .daedalus/import.tgz --strip-components=1 -C . && rm -f .daedalus/import.tgz && ls -A | head -n 50",
    { timeoutMs: 120_000 },
  );
  if (extract.exitCode !== 0) throw new Error(`Couldn't extract the archive: ${extract.stderr.slice(0, 500)}`);

  const pkgRaw = await sandbox.readFile("package.json");
  const pkg = pkgRaw ? (JSON.parse(new TextDecoder().decode(pkgRaw)) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }) : null;
  if (pkg) {
    const has = async (f: string) => (await sandbox.exec(`test -f ${shellQuote(f)} && echo y || echo n`, { timeoutMs: 15_000 })).stdout.trim() === "y";
    const install = (await has("pnpm-lock.yaml"))
      ? "corepack enable >/dev/null 2>&1; pnpm install --no-frozen-lockfile"
      : (await has("yarn.lock"))
        ? "corepack enable >/dev/null 2>&1; yarn install"
        : (await has("bun.lockb")) || (await has("bun.lock"))
          ? "npx -y bun install"
          : "npm install --no-audit --no-fund --loglevel=error";
    await log("Installing dependencies");
    const r = await sandbox.exec(install, { timeoutMs: 240_000, env: { CI: "1" } });
    if (r.exitCode !== 0) await log(`Install finished with errors; the agent can fix them (${(r.stderr || r.stdout).split("\n").filter(Boolean).pop()?.slice(0, 160) ?? ""})`);
  }

  await sandbox.writeFiles([{ path: ".daedalus/dev.sh", content: devScript(pkg, previewHost) }]);
  await sandbox.exec("chmod +x .daedalus/dev.sh", { timeoutMs: 10_000 });

  await log("Starting version history");
  const git = await sandbox.exec(
    [
      "rm -rf .git",
      "git init -q -b main 2>/dev/null || git init -q",
      'git config user.name "Daedalus"',
      'git config user.email "agent@daedalus.dev"',
      'grep -qx ".daedalus/" .gitignore 2>/dev/null || printf "\\n.daedalus/\\nnode_modules/\\n" >> .gitignore',
      "git add -A",
      `git commit -q -m ${shellQuote(`Import ${source.repo}@${ref}`)} || true`,
    ].join(" && "),
    { timeoutMs: 120_000 },
  );
  if (git.exitCode !== 0) throw new Error(`git init failed: ${git.stderr.slice(0, 300)}`);
}

type Pkg = { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null;

/** How to run this repo's dev server on the preview port (5173), whatever its framework. */
export function devScript(pkg: Pkg, previewHost: string | null): string {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const env = ["export PORT=5173 HOST=0.0.0.0 BROWSER=none", previewHost ? `export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(previewHost)}` : ""].filter(Boolean).join("\n");
  let run: string;
  if (!pkg) run = "exec python3 -m http.server 5173 --bind 0.0.0.0";
  else if (deps.vite) run = "exec npx vite --host 0.0.0.0 --port 5173 --strictPort";
  else if (deps.next) run = "exec npx next dev -p 5173 -H 0.0.0.0";
  else if (deps["react-scripts"]) run = "exec npx react-scripts start";
  else if (deps.astro) run = "exec npx astro dev --host 0.0.0.0 --port 5173";
  else if (pkg.scripts?.dev) run = "exec npm run dev";
  else if (pkg.scripts?.start) run = "exec npm start";
  else run = "exec npx -y serve -l 5173 .";
  return `#!/usr/bin/env bash\n# Generated by Daedalus on import: runs this project's dev server on the preview port.\n${env}\n${run}\n`;
}
