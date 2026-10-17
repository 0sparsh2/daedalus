// Turn-router smoke test: sends messages and checks which route each one takes. With the mock
// model only the rules run; with --real (TEST_NVIDIA_API_KEY) the fast-model classifier runs
// too. Non-chat runs are stopped as soon as their route is known, so no full builds happen.
// Usage: node scripts/smoke-route.mjs [--real] [baseUrl]
import { createClient } from "@supabase/supabase-js";

const REAL = process.argv.includes("--real");
const BASE = process.argv.filter((a) => !a.startsWith("--"))[2] ?? "http://localhost:3100";
const CASES = REAL
  ? [
      ["plan", "Hi", "chat"],
      ["plan", "What can you build?", "chat"],
      ["plan", "A habit tracker with daily streaks", "plan"],
      ["build", "How does Daedalus save my work?", "chat"],
      ["build", "Add a dark mode toggle", "build"],
      ["plan", "Make the header blue", "plan"],
      ["build", "Which file renders the home page?", "ask"],
    ]
  : [
      ["plan", "Hi", "chat"],
      ["build", "thanks!", "chat"],
      ["plan", "[mock:plan] A booking app", "plan"],
    ];

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = `route+${Date.now()}@daedalus.test`;
await admin.auth.admin.createUser({ email, password: "route-test-123", email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email, password: "route-test-123" });
const auth = { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" };
const key = REAL ? { provider: "nvidia", apiKey: process.env.TEST_NVIDIA_API_KEY, model: "nvidia/nemotron-3-super-120b-a12b" } : { provider: "mock", apiKey: "mock-key-for-tests", model: "mock-builder" };
const cred = await fetch(`${BASE}/api/credentials`, { method: "POST", headers: auth, body: JSON.stringify(key) });
if (!cred.ok) throw new Error(`connect key: ${cred.status} ${await cred.text()}`);

const rows = [];
for (const [mode, text, expected] of CASES) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: auth, body: JSON.stringify({ message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] }, mode }) });
  if (!res.ok) {
    rows.push({ mode, text, expected, got: `HTTP ${res.status}` });
    continue;
  }
  const runId = res.headers.get("x-daedalus-run-id");
  let route, routeMs, firstTextMs, say = "", sandbox = false, stopped = false, buf = "";
  for await (const chunk of res.body) {
    buf += new TextDecoder().decode(chunk);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, "");
      buf = buf.slice(i + 2);
      if (!line.startsWith("{")) continue;
      const e = JSON.parse(line);
      if (e.type === "message-metadata" && e.messageMetadata?.route) {
        route = e.messageMetadata.route;
        routeMs = Date.now() - t0;
        if (route.route !== "chat" && !stopped) {
          stopped = true;
          await fetch(`${BASE}/api/runs/${runId}/stop`, { method: "POST", headers: auth });
        }
      }
      if (e.type === "data-status") sandbox = true;
      if (e.type === "text-delta") {
        say += e.delta;
        firstTextMs ??= Date.now() - t0;
      }
    }
  }
  rows.push({ mode, text: text.slice(0, 40), expected, got: route?.route, ok: route?.route === expected ? "✓" : "✗", by: route?.by, routeMs, firstTextMs, sandbox, reply: say.replace(/\s+/g, " ").slice(0, 70) });
}
console.table(rows);
const failed = rows.filter((r) => r.ok !== "✓").length;
console.log(failed ? `${failed} misrouted` : "all routed as expected");
process.exit(failed ? 1 : 0);
