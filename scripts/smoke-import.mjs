// Imports a public GitHub repo into a new project and runs a scripted explore turn.
// Usage: node scripts/smoke-import.mjs [repoUrl] [baseUrl]
import { createClient } from "@supabase/supabase-js";
const REPO = process.argv[2] ?? "https://github.com/mdn/todo-react";
const BASE = process.argv[3] ?? "http://localhost:3100";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = `import+${Date.now()}@daedalus.test`;
await admin.auth.admin.createUser({ email, password: "import-password-123", email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email, password: "import-password-123" });
const auth = { authorization: `Bearer ${data.session.access_token}` };
const t0 = Date.now();
const imp = await fetch(`${BASE}/api/projects/import`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ url: REPO }) });
const ij = await imp.json();
console.log("import", imp.status, ij.project?.name, ij.repo?.repo, ij.repo?.ref, ij.error?.message ?? "");
if (!imp.ok) process.exit(1);
const res = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ projectId: ij.project.id, message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text: "[mock:explore] Give me an overview" }] }, mode: "build", model: { provider: "mock", model: "mock-builder" } }),
});
let text = "";
for await (const c of res.body) text += new TextDecoder().decode(c);
for (const m of text.matchAll(/"type":"data-status","id":"status","data":\{"stage":"([^"]+)","note":"([^"]+)"/g)) console.log(`  status ${m[1]}: ${m[2]}`);
const preview = text.match(/"type":"data-preview","id":"preview","data":\{"url":"([^"]+)"/)?.[1];
const probe = text.match(/Preview (is healthy[^"\\]*|has \d+ problem)/)?.[0];
console.log(`run done in ${((Date.now() - t0) / 1000).toFixed(1)}s · preview ${preview} · ${probe}`);
if (preview) {
  const r = await fetch(preview);
  const html = await r.text();
  console.log("preview fetch", r.status, (html.match(/<title>([^<]*)<\/title>/) ?? [])[1]);
}
const proj = await (await fetch(`${BASE}/api/projects/${ij.project.id}`, { headers: auth })).json();
console.log("checkpoints", proj.checkpoints.length, "| messages", proj.messages.map((m) => `${m.role}:${m.parts.length}`).join(" "), "| github_repo", proj.project.github_repo);
const files = await (await fetch(`${BASE}/api/projects/${ij.project.id}/files`, { headers: auth })).json();
console.log("files", files.files?.length, files.files?.slice(0, 8).join(", "));
