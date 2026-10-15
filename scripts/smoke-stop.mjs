// Starts a slow scripted run, stops it mid-way, and checks it ends cleanly as cancelled.
import { createClient } from "@supabase/supabase-js";
const BASE = process.argv[2] ?? "http://localhost:3100";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = `stop+${Date.now()}@daedalus.test`;
await admin.auth.admin.createUser({ email, password: "stop-password-123", email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email, password: "stop-password-123" });
const auth = { authorization: `Bearer ${data.session.access_token}` };
const t0 = Date.now();
const res = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text: "[mock:slow] go" }] }, mode: "build", model: { provider: "mock", model: "mock-builder" } }),
});
const runId = res.headers.get("x-daedalus-run-id");
const projectId = res.headers.get("x-daedalus-project-id");
setTimeout(async () => {
  const r = await fetch(`${BASE}/api/runs/${runId}/stop`, { method: "POST", headers: auth });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] stop requested`, r.status);
}, 6000);
let text = "";
for await (const c of res.body) text += new TextDecoder().decode(c);
console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] stream closed; run-end part:`, /data-run-end/.test(text), "| third turn reached:", /never be reached/.test(text));
const trace = await (await fetch(`${BASE}/api/runs/${runId}/spans`, { headers: auth })).json();
console.log("run status", trace.run.status, "| llm calls", trace.run.llm_calls, "| error spans", trace.spans.filter((s) => s.status === "error").map((s) => `${s.kind}:${s.name}`).join(", "));
const proj = await (await fetch(`${BASE}/api/projects/${projectId}`, { headers: auth })).json();
console.log("messages", proj.messages.map((m) => `${m.role}:${m.parts.length}`).join(" "), "| checkpoints", proj.checkpoints.length);
