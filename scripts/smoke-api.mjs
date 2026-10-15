// End-to-end API smoke test against a running dev server and local Supabase, using the
// scripted mock model. Usage: node scripts/smoke-api.mjs <scenario> [baseUrl]
import { createClient } from "@supabase/supabase-js";

const scenario = process.argv[2] ?? "hello";
const BASE = process.argv[3] ?? "http://localhost:3100";
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SB_SECRET = process.env.SUPABASE_SECRET_KEY;
const SB_PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const admin = createClient(SB_URL, SB_SECRET, { auth: { persistSession: false } });
const email = `smoke+${Date.now()}@daedalus.test`;
const password = "smoke-test-password-123";
const { error: ce } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (ce) throw ce;
const anon = createClient(SB_URL, SB_PUB, { auth: { persistSession: false } });
const { data: session, error: se } = await anon.auth.signInWithPassword({ email, password });
if (se) throw se;
const auth = { authorization: `Bearer ${session.session.access_token}` };

const t0 = Date.now();
const res = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({
    message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text: `[mock:${scenario}] Smoke test` }] },
    mode: scenario === "plan" ? "plan" : "build",
    model: { provider: "mock", model: "mock-builder" },
  }),
});
console.log("POST /api/chat", res.status, res.headers.get("x-daedalus-project-id"));
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}
const projectId = res.headers.get("x-daedalus-project-id");
const runId = res.headers.get("x-daedalus-run-id");
const counts = {};
const dataParts = [];
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const evt = buf.slice(0, i).replace(/^data: /, "");
    buf = buf.slice(i + 2);
    if (!evt || evt === "[DONE]") continue;
    const j = JSON.parse(evt);
    counts[j.type] = (counts[j.type] ?? 0) + 1;
    if (j.type.startsWith("data-")) dataParts.push(`${j.type}:${JSON.stringify(j.data).slice(0, 120)}`);
    if (j.type === "tool-input-available") console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] tool ${j.toolName}`);
    if (j.type === "tool-output-available") console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s]   -> ${JSON.stringify(j.output).slice(0, 160)}`);
    if (j.type === "error") console.log("  ERROR", j.errorText);
  }
}
console.log(`stream done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, counts);
for (const d of dataParts) console.log("  ", d);

const proj = await (await fetch(`${BASE}/api/projects/${projectId}`, { headers: auth })).json();
console.log("project", proj.project?.name, proj.project?.status, "preview", proj.project?.preview_url);
console.log("messages", proj.messages?.map((m) => `${m.role}:${m.parts.length} parts`).join(", "));
console.log("checkpoints", proj.checkpoints?.map((c) => `${c.sha.slice(0, 7)} ${c.message}`).join(" | "));
const trace = await (await fetch(`${BASE}/api/runs/${runId}/spans`, { headers: auth })).json();
console.log("run", trace.run?.status, "llm", trace.run?.llm_calls, "tools", trace.run?.tool_calls, "tokens", trace.run?.input_tokens, "/", trace.run?.output_tokens, trace.run?.error ?? "");
const byId = Object.fromEntries(trace.spans.map((s) => [s.id, s]));
const depth = (s) => (s.parent_id && byId[s.parent_id] && s.parent_id !== s.id ? 1 + depth(byId[s.parent_id]) : 0);
for (const s of trace.spans) console.log(`  ${"  ".repeat(depth(s))}${s.kind.padEnd(8)} ${s.name.padEnd(28)} ${s.status.padEnd(9)} ${s.duration_ms ?? ""}ms`);
if (proj.project?.preview_url) {
  const pv = await fetch(proj.project.preview_url).catch((e) => ({ status: String(e) }));
  console.log("preview fetch", pv.status);
}
console.log(JSON.stringify({ projectId, runId, email }));
