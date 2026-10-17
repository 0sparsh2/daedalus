// Customize with a real model (NIM): install the Docs research kit, then one plan-mode turn
// that should use the docs-first skill, the Context7 connection and the remember tool.
// Reads TEST_NVIDIA_API_KEY; never prints it. Usage: node scripts/smoke-customize-real.mjs [baseUrl]
import { createClient } from "@supabase/supabase-js";

const BASE = process.argv[2] ?? "http://localhost:3100";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = `cust-real+${Date.now()}@daedalus.test`;
await admin.auth.admin.createUser({ email, password: "cust-real-123", email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email, password: "cust-real-123" });
const auth = { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" };
const t0 = Date.now();
const ts = () => `[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`;
const cred = await fetch(`${BASE}/api/credentials`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "nvidia", apiKey: process.env.TEST_NVIDIA_API_KEY, model: "nvidia/nemotron-3-super-120b-a12b" }) });
if (!cred.ok) throw new Error(`key: ${cred.status}`);

async function turn(projectId, text, mode) {
  const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: auth, body: JSON.stringify({ projectId, message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] }, mode }) });
  const pid = res.headers.get("x-daedalus-project-id");
  const names = new Map();
  let buf = "", say = "";
  for await (const chunk of res.body) {
    buf += new TextDecoder().decode(chunk);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, "");
      buf = buf.slice(i + 2);
      if (!line.startsWith("{")) continue;
      const e = JSON.parse(line);
      if (e.type === "message-metadata" && e.messageMetadata?.route) console.log(ts(), "route:", e.messageMetadata.route.route, "·", e.messageMetadata.route.reason);
      if (e.type === "tool-input-available") {
        names.set(e.toolCallId, e.toolName);
        console.log(ts(), "tool", e.toolName, JSON.stringify(e.input).slice(0, 110));
      }
      if (e.type === "tool-output-available") console.log(ts(), `  ${e.output?.ok === false ? "✗" : "✓"}`, String(e.output?.text ?? "").split("\n")[0].slice(0, 110));
      if (e.type === "tool-input-error" || e.type === "tool-output-error") console.log(ts(), "  ✗", String(e.errorText).slice(0, 140));
      if (e.type === "text-delta") say += e.delta;
    }
  }
  console.log(ts(), "reply:", say.replace(/\s+/g, " ").slice(0, 260));
  return pid;
}

const pid = await turn(undefined, "Plan a simple stopwatch app with laps.", "plan");
const kit = await fetch(`${BASE}/api/projects/${pid}/kits`, { method: "POST", headers: auth, body: JSON.stringify({ id: "docs-research" }) });
console.log(ts(), "installed Docs research kit:", kit.status, JSON.stringify((await kit.json()).installed));
await turn(pid, "Two things. I always want metric units and British spelling in anything you make for me, please remember that. And I want to add a markdown notes panel later: what does the react-markdown library recommend for GitHub-flavoured markdown (tables, task lists)? Check its current docs.", "plan");
const mems = await (await fetch(`${BASE}/api/projects/${pid}/memories`, { headers: auth })).json();
console.log(ts(), "memories proposed:", JSON.stringify(mems.memories?.map((m) => `${m.status}: ${m.text}`)));
