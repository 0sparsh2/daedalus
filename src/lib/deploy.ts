import "server-only";
import { createHash } from "node:crypto";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import type { SandboxHandle } from "@/lib/sandbox";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Deploys a user's app: build in the sandbox (vite build → dist/), upload each output file to
 * Vercel by SHA-1 (unchanged files are deduplicated by Vercel), then create a production
 * deployment of a per-project Vercel project under the Daedalus team and wait until it's live.
 */

const API = "https://api.vercel.com";

export function deployConfigured() {
  return Boolean(env.vercelDeployToken());
}

async function vercel<T>(path: string, init: RequestInit = {}): Promise<T> {
  const team = env.vercelDeployTeamId();
  const url = `${API}${path}${team ? `${path.includes("?") ? "&" : "?"}teamId=${team}` : ""}`;
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${env.vercelDeployToken()}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 400);
    try {
      msg = JSON.parse(body).error?.message ?? msg;
    } catch {}
    throw new HttpError(502, `Vercel: ${msg}`, "vercel_error");
  }
  return (await res.json()) as T;
}

function projectSlug(name: string, id: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "app";
  return `${base}-${id.slice(0, 6)}`;
}

export async function deployProject(userId: string, project: { id: string; name: string }, sandbox: SandboxHandle) {
  if (!deployConfigured()) throw new HttpError(501, "Deploys aren't configured on this server (VERCEL_DEPLOY_TOKEN).", "deploy_not_configured");
  const db = supabaseAdmin();
  const sha = (await sandbox.exec("git rev-parse HEAD 2>/dev/null || true", { timeoutMs: 15_000 })).stdout.trim() || null;
  const { data: row } = await db
    .from("deployments")
    .insert({ project_id: project.id, user_id: userId, status: "building", checkpoint_sha: sha })
    .select("id")
    .single();
  const fail = async (message: string) => {
    if (row) await db.from("deployments").update({ status: "error", error: message.slice(0, 1000) }).eq("id", row.id);
    return new HttpError(422, message, "deploy_failed");
  };

  const build = await sandbox.exec("npm run build > /tmp/daedalus-build.log 2>&1; echo EXIT:$?; tail -n 40 /tmp/daedalus-build.log", { timeoutMs: 240_000 });
  if (!/EXIT:0/.test(build.stdout)) throw await fail(`The production build failed:\n${build.stdout.replace(/EXIT:\d+\n?/, "").slice(-1500)}`);

  const list = await sandbox.exec("cd dist && find . -type f | sed 's#^\\./##' | head -n 3000", { timeoutMs: 30_000 });
  const paths = list.stdout.split("\n").filter(Boolean);
  if (!paths.includes("index.html")) throw await fail("The build didn't produce dist/index.html.");

  const files: Array<{ file: string; sha: string; size: number }> = [];
  const queue = [...paths];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const bytes = await sandbox.readFile(`dist/${p}`);
      if (!bytes) continue;
      const digest = createHash("sha1").update(bytes).digest("hex");
      await vercel("/v2/files", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "x-vercel-digest": digest, "content-length": String(bytes.length) },
        body: Buffer.from(bytes),
      });
      files.push({ file: p, sha: digest, size: bytes.length });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  // Single-page apps: send unknown paths to index.html (static files still win).
  const config = Buffer.from(JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/index.html" }] }));
  const configSha = createHash("sha1").update(config).digest("hex");
  await vercel("/v2/files", { method: "POST", headers: { "content-type": "application/octet-stream", "x-vercel-digest": configSha, "content-length": String(config.length) }, body: config });
  files.push({ file: "vercel.json", sha: configSha, size: config.length });

  const name = projectSlug(project.name, project.id);
  const dep = await vercel<{ id: string; url: string; alias?: string[]; projectId: string }>("/v13/deployments?skipAutoDetectionConfirmation=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, files, target: "production", projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null } }),
  });
  // Make the production URL public (new projects may default to deployment protection).
  await vercel(`/v9/projects/${dep.projectId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ssoProtection: null }) }).catch(() => {});

  let ready: { readyState: string; alias?: string[]; url: string; errorMessage?: string } | null = null;
  for (let i = 0; i < 60; i++) {
    const d = await vercel<{ readyState: string; alias?: string[]; url: string; errorMessage?: string }>(`/v13/deployments/${dep.id}`);
    if (d.readyState === "READY" || d.readyState === "ERROR" || d.readyState === "CANCELED") {
      ready = d;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ready || ready.readyState !== "READY") throw await fail(`Deployment didn't become ready: ${ready?.errorMessage ?? ready?.readyState ?? "timed out"}`);
  const url = `https://${ready.alias?.find((a) => a.endsWith(".vercel.app") && !a.includes(dep.id)) ?? ready.alias?.[0] ?? ready.url}`;
  if (row) await db.from("deployments").update({ status: "ready", url, external_id: dep.id }).eq("id", row.id);
  await db.from("projects").update({ deploy_url: url }).eq("id", project.id);
  return { url, deploymentId: dep.id };
}
