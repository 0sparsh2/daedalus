// Builds a Vercel Sandbox snapshot of the provisioned starter app (dependencies installed,
// git initialised, marker written) so new projects skip `npm ci`. Prints the snapshot id to
// set as VERCEL_TEMPLATE_SNAPSHOT_ID. Needs Vercel credentials: run `vercel env pull` (OIDC)
// or set VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID.
import { Sandbox } from "@vercel/sandbox";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../sandbox-template/", import.meta.url));
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ path: `/vercel/sandbox/${relative(root, p)}`, content: readFileSync(p) });
  }
})(root);

const creds = process.env.VERCEL_TOKEN ? { token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID, projectId: process.env.VERCEL_PROJECT_ID } : {};
const t0 = Date.now();
const sbx = await Sandbox.create({ ports: [5173], timeout: 15 * 60_000, resources: { vcpus: 2 }, persistent: false, ...creds });
const run = async (cmd) => {
  const r = await sbx.runCommand({ cmd: "bash", args: ["-lc", cmd], cwd: "/vercel/sandbox" });
  const out = (await r.stdout()) + (await r.stderr());
  if (r.exitCode !== 0) throw new Error(`${cmd} failed (${r.exitCode}):\n${out.slice(-2000)}`);
  return out;
};
try {
  await sbx.writeFiles(files);
  console.log("node", (await run("node -v")).trim(), "· git", (await run("git --version")).trim(), "· rg", (await run("command -v rg || echo missing")).trim());
  await run("npm ci --no-audit --no-fund --loglevel=error");
  await run('git init -q -b main && git config user.name "Daedalus" && git config user.email "agent@daedalus.dev" && git add -A && git commit -q -m "Start from the Daedalus starter app" && mkdir -p .daedalus && date -u +%FT%TZ > .daedalus/provisioned');
  const snap = await sbx.snapshot({ expiration: 0 });
  console.log(`snapshot ready in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`VERCEL_TEMPLATE_SNAPSHOT_ID=${snap.snapshotId}`);
} catch (err) {
  await sbx.stop().catch(() => {});
  throw err;
}
