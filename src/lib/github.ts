import "server-only";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import type { SandboxHandle } from "@/lib/sandbox";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * GitHub integration. Users connect with an OAuth app (scope `repo`); the token is encrypted
 * like model keys. Pushes use the Git Data API from the server: the token never enters the
 * sandbox, and no git credentials are stored there.
 */

const GH = "https://api.github.com";

export function githubConfigured() {
  return Boolean(env.githubClientId() && env.githubClientSecret());
}

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 300);
    try {
      msg = JSON.parse(body).message ?? msg;
    } catch {}
    if (res.status === 401) throw new HttpError(401, "GitHub rejected the token. Reconnect GitHub.", "github_unauthorized");
    throw new HttpError(res.status >= 500 ? 502 : 400, `GitHub: ${msg}`, "github_error");
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export async function exchangeCode(code: string): Promise<{ token: string; scopes: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.githubClientId(), client_secret: env.githubClientSecret(), code }),
  });
  const j = (await res.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!j.access_token) throw new HttpError(400, j.error_description ?? "GitHub sign-in failed", "github_oauth");
  return { token: j.access_token, scopes: j.scope ?? "" };
}

export async function saveConnection(userId: string, token: string, scopes: string) {
  const me = await gh<{ login: string }>(token, "/user");
  const { error } = await supabaseAdmin()
    .from("github_connections")
    .upsert({ user_id: userId, github_login: me.login, token_ciphertext: encryptSecret(token, userId), scopes }, { onConflict: "user_id" });
  if (error) throw new HttpError(500, error.message);
  return me.login;
}

export async function getConnection(userId: string): Promise<{ login: string; token: string } | null> {
  const { data } = await supabaseAdmin().from("github_connections").select("github_login,token_ciphertext").eq("user_id", userId).maybeSingle();
  if (!data) return null;
  return { login: data.github_login, token: decryptSecret(data.token_ciphertext, userId) };
}

function slug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "daedalus-app";
}

async function ensureRepo(token: string, login: string, project: { name: string; github_repo: string | null; description: string | null }) {
  if (project.github_repo) {
    const repo = await gh<{ full_name: string; default_branch: string }>(token, `/repos/${project.github_repo}`);
    return { fullName: repo.full_name, branch: repo.default_branch };
  }
  const base = slug(project.name);
  for (let i = 0; i < 5; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    try {
      // auto_init gives the repo a first commit; the Git Data API can't write to empty repos.
      const repo = await gh<{ full_name: string; default_branch: string }>(token, "/user/repos", {
        method: "POST",
        body: JSON.stringify({ name, private: true, auto_init: true, description: (project.description ?? "Built with Daedalus").slice(0, 300) }),
      });
      return { fullName: repo.full_name, branch: repo.default_branch };
    } catch (err) {
      if (err instanceof HttpError && /name already exists/i.test(err.message)) continue;
      throw err;
    }
  }
  throw new HttpError(409, `Couldn't find a free repository name for ${login}/${base}`, "github_name");
}

/** Pushes the sandbox's committed tree as one commit on the repo's default branch. */
export async function pushProject(
  userId: string,
  project: { id: string; name: string; github_repo: string | null; description: string | null },
  sandbox: SandboxHandle,
) {
  const conn = await getConnection(userId);
  if (!conn) throw new HttpError(412, "Connect GitHub first.", "github_not_connected");
  const { fullName, branch } = await ensureRepo(conn.token, conn.login, project);

  const ls = await sandbox.exec("git add -A && (git diff --cached --quiet || git commit -q -m 'Save before push') ; git ls-files", { timeoutMs: 60_000 });
  const paths = ls.stdout.split("\n").filter(Boolean).slice(0, 2000);
  const msgRes = await sandbox.exec("git log -1 --pretty=%s", { timeoutMs: 15_000 });
  const message = msgRes.stdout.trim() || "Update from Daedalus";

  const tree: Array<{ path: string; mode: string; type: "blob"; content?: string; sha?: string }> = [];
  const queue = [...paths];
  const worker = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const bytes = await sandbox.readFile(p);
      if (!bytes) continue;
      const isBinary = bytes.subarray(0, 8000).includes(0);
      if (!isBinary) {
        tree.push({ path: p, mode: "100644", type: "blob", content: new TextDecoder().decode(bytes) });
      } else {
        const blob = await gh<{ sha: string }>(conn.token, `/repos/${fullName}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: Buffer.from(bytes).toString("base64"), encoding: "base64" }),
        });
        tree.push({ path: p, mode: "100644", type: "blob", sha: blob.sha });
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  tree.sort((a, b) => a.path.localeCompare(b.path));

  const ref = await gh<{ object: { sha: string } }>(conn.token, `/repos/${fullName}/git/ref/heads/${branch}`);
  const newTree = await gh<{ sha: string }>(conn.token, `/repos/${fullName}/git/trees`, { method: "POST", body: JSON.stringify({ tree }) });
  const commit = await gh<{ sha: string }>(conn.token, `/repos/${fullName}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }),
  });
  await gh(conn.token, `/repos/${fullName}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
  await supabaseAdmin().from("projects").update({ github_repo: fullName, github_branch: branch, github_last_sha: commit.sha }).eq("id", project.id);
  return { repo: fullName, sha: commit.sha, url: `https://github.com/${fullName}/commit/${commit.sha}`, files: tree.length };
}
