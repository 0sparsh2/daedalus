// Customize layer smoke test against a running dev server (mock model): skills now; rules,
// connections and memory as they land. Prints PASS/FAIL per check.
// Usage: node scripts/smoke-customize.mjs [baseUrl]
import { createClient } from "@supabase/supabase-js";

const BASE = process.argv[2] ?? "http://localhost:3100";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = `customize+${Date.now()}@daedalus.test`;
await admin.auth.admin.createUser({ email, password: "customize-test-123", email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email, password: "customize-test-123" });
const auth = { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" };
const call = async (method, path, json) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: auth, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` · ${extra}` : ""}`);
};

/** Runs one turn and returns its tool outputs by tool name. */
async function turn(projectId, text, mode = "build") {
  const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: auth, body: JSON.stringify({ projectId, message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] }, mode }) });
  const projId = res.headers.get("x-daedalus-project-id");
  const tools = [];
  const names = new Map();
  let buf = "";
  for await (const chunk of res.body) {
    buf += new TextDecoder().decode(chunk);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i).replace(/^data: /, "");
      buf = buf.slice(i + 2);
      if (!line.startsWith("{")) continue;
      const e = JSON.parse(line);
      if (e.type === "tool-input-available") names.set(e.toolCallId, { name: e.toolName, input: e.input });
      if (e.type === "tool-output-available") tools.push({ ...names.get(e.toolCallId), output: e.output });
    }
  }
  return { projectId: projId, tools };
}

await call("POST", "/api/credentials", { provider: "mock", apiKey: "mock-key-for-tests", model: "mock-builder" });
const first = await turn(undefined, "[mock:hello] Start the project");
const pid = first.projectId;
check("project started", Boolean(pid));

// Skills
let skills = await call("GET", `/api/projects/${pid}/skills`);
check("built-in skills listed", skills.body?.builtin?.length >= 5, skills.body?.builtin?.map((s) => s.name).join(", "));
const created = await call("POST", `/api/projects/${pid}/skills`, { name: "brand-voice", description: "Write the way Acme talks. Use for customer-facing text.", body: "- Warm and short.\n- Sign off as The Acme team." });
check("project skill saved to the repo", created.status === 200 && created.body?.path === ".agents/skills/brand-voice/SKILL.md", created.body?.path ?? created.body?.error?.message);
const bad = await call("POST", `/api/projects/${pid}/skills`, { name: "Brand Voice", description: "x", body: "y" });
check("invalid skill name rejected", bad.status === 400);
await call("PATCH", `/api/projects/${pid}/skills`, { name: "charts", enabled: false });
skills = await call("GET", `/api/projects/${pid}/skills`);
check("project skill listed", skills.body?.project?.some((s) => s.name === "brand-voice"));
check("built-in switched off", skills.body?.builtin?.find((s) => s.name === "charts")?.enabled === false);
const used = await turn(pid, "[mock:skill] Use the skills");
const brand = used.tools.find((t) => t.input?.name === "brand-voice");
const charts = used.tools.find((t) => t.input?.name === "charts");
check("agent loads the project skill", brand?.output?.ok === true && /Sign off as The Acme team/.test(brand.output.text));
check("switched-off built-in is refused", charts?.output?.ok === false, charts?.output?.text?.slice(0, 80));
await call("DELETE", `/api/projects/${pid}/skills?name=brand-voice`);
skills = await call("GET", `/api/projects/${pid}/skills`);
check("project skill deleted", skills.body?.project?.length === 0);

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
