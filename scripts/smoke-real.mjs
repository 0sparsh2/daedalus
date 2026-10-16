// Real-model end-to-end run: connects a provider key through /api/credentials (validated and
// encrypted like any user's), then streams a build and prints a condensed timeline, the trace
// summary and the preview status. Reads TEST_NVIDIA_API_KEY; never prints it.
// Usage: node scripts/smoke-real.mjs "<prompt>" [model] [mode] [baseUrl] [projectId]
import { createClient } from "@supabase/supabase-js";

const PROMPT = process.argv[2] ?? "Build a habit tracker: add and remove habits, tick a habit off for today, show a streak count per habit, and keep everything in localStorage.";
const MODEL = process.argv[3] ?? "nvidia/nemotron-3-super-120b-a12b";
const MODE = process.argv[4] ?? "build";
const BASE = process.argv[5] ?? "http://localhost:3100";
const PROJECT = process.argv[6];
const KEY = process.env.TEST_NVIDIA_API_KEY;
if (!KEY) throw new Error("TEST_NVIDIA_API_KEY is not set");

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = process.env.REAL_EMAIL ?? `real+${Date.now()}@daedalus.test`;
const password = "real-test-password-123";
if (!process.env.REAL_EMAIL) await admin.auth.admin.createUser({ email, password, email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data, error } = await anon.auth.signInWithPassword({ email, password });
if (error) throw error;
const auth = { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" };

const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
const cred = await fetch(`${BASE}/api/credentials`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "nvidia", apiKey: KEY, model: MODEL }) });
console.log(ts(), "connect key:", cred.status, cred.ok ? "ok" : (await cred.json()).error?.message);
if (!cred.ok) process.exit(1);

const res = await fetch(`${BASE}/api/chat`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ projectId: PROJECT, message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text: PROMPT }] }, mode: MODE }),
});
console.log(ts(), "POST /api/chat", res.status, MODEL, MODE);
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}
const projectId = res.headers.get("x-daedalus-project-id");
const runId = res.headers.get("x-daedalus-run-id");
// Optional: press Stop mid-run (STOP_AFTER_MS) to check that in-flight model calls are cut off.
if (process.env.STOP_AFTER_MS) {
  setTimeout(async () => {
    const r = await fetch(`${BASE}/api/runs/${runId}/stop`, { method: "POST", headers: auth });
    console.log(ts(), "STOP requested", r.status);
  }, Number(process.env.STOP_AFTER_MS));
}
const texts = new Map();
const inputs = new Map();
let buf = "";
let previewUrl = null;
const dec = new TextDecoder();
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, i).replace(/^data: /, "");
    buf = buf.slice(i + 2);
    if (!raw || raw === "[DONE]") continue;
    const e = JSON.parse(raw);
    switch (e.type) {
      case "text-delta":
        texts.set(e.id, (texts.get(e.id) ?? "") + e.delta);
        break;
      case "text-end": {
        const t = (texts.get(e.id) ?? "").trim();
        if (t) console.log(ts(), "say:", t.replace(/\s+/g, " ").slice(0, 220));
        texts.delete(e.id);
        break;
      }
      case "reasoning-end":
        console.log(ts(), "(thinking)");
        break;
      case "tool-input-available": {
        inputs.set(e.toolCallId, e.toolName);
        const inp = e.input ?? {};
        const brief = inp.path ?? inp.command ?? inp.pattern ?? inp.task ?? inp.action ?? (inp.todos ? `${inp.todos.length} todos` : JSON.stringify(inp).slice(0, 80));
        console.log(ts(), `tool ${e.toolName}:`, String(brief).slice(0, 140));
        break;
      }
      case "tool-output-available": {
        const o = e.output ?? {};
        const first = String(o.text ?? "").split("\n")[0].slice(0, 140);
        console.log(ts(), `  ${o.ok === false ? "✗" : "✓"} ${inputs.get(e.toolCallId)}: ${first}`);
        break;
      }
      case "tool-output-error":
      case "tool-input-error":
        console.log(ts(), `  ✗ ${e.type} ${inputs.get(e.toolCallId) ?? e.toolName ?? ""}: ${String(e.errorText).slice(0, 200)}`);
        break;
      case "data-status":
        console.log(ts(), "status:", e.data?.note);
        break;
      case "data-preview":
        previewUrl = e.data?.url;
        break;
      case "data-check":
        console.log(ts(), "check:", JSON.stringify(e.data));
        break;
      case "data-checkpoint":
        console.log(ts(), "version:", e.data?.sha?.slice(0, 7), e.data?.message);
        break;
      case "data-subagent":
        if (e.data?.status !== "running") console.log(ts(), `sub-agent ${e.data?.kind} ${e.data?.status}: ${(e.data?.summary ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
        break;
      case "data-run-end":
        console.log(ts(), "run end:", e.data?.note);
        break;
      case "error":
        console.log(ts(), "ERROR:", e.errorText);
        break;
    }
  }
}
console.log(ts(), "stream closed");
const trace = await (await fetch(`${BASE}/api/runs/${runId}/spans`, { headers: auth })).json();
const r = trace.run;
console.log(`run ${r.status} · ${r.llm_calls} model calls · ${r.tool_calls} tool calls · ${r.input_tokens} in / ${r.output_tokens} out${r.error ? ` · error: ${r.error}` : ""}`);
const bad = trace.spans.filter((s) => s.status === "error");
if (bad.length) console.log("error spans:", bad.map((s) => `${s.kind}:${s.name}${s.error ? ` (${String(s.error).slice(0, 120)})` : ""}`).join(" | "));
const llm = trace.spans.filter((s) => s.kind === "llm" && s.duration_ms);
if (llm.length) {
  const d = llm.map((s) => s.duration_ms).sort((a, b) => a - b);
  console.log(`model call latency: median ${(d[Math.floor(d.length / 2)] / 1000).toFixed(1)}s · max ${(d[d.length - 1] / 1000).toFixed(1)}s`);
}
if (previewUrl) {
  const pv = await fetch(previewUrl).catch((e) => ({ status: String(e) }));
  console.log("preview", previewUrl, pv.status);
}
console.log(JSON.stringify({ projectId, runId, email, previewUrl, status: r.status, llmCalls: r.llm_calls, toolCalls: r.tool_calls, inputTokens: r.input_tokens, outputTokens: r.output_tokens, seconds: Math.round((Date.now() - t0) / 1000) }));
