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
  const checks = [];
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
      if (e.type === "data-check" && e.data?.status !== "running") checks.push(e.data);
    }
  }
  return { projectId: projId, tools, checks };
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

// Rules that always run
const rulesPut = await call("PUT", `/api/projects/${pid}/rules`, {
  rules: [
    { id: "r1", event: "before_command", pattern: "npm install", reason: "Ask first." },
    { id: "r2", event: "after_change", glob: "src/**/*.txt", command: "echo formatted {file}" },
    { id: "r3", event: "before_finish", label: "Marker exists", command: "test -f src/rule-ok.txt" },
  ],
});
check("rules saved", rulesPut.status === 200 && rulesPut.body?.rules?.length === 3);
const badRules = await call("PUT", `/api/projects/${pid}/rules`, { rules: [{ id: "x", event: "before_finish" }] });
check("invalid rule rejected", badRules.status === 400);
const ruled = await turn(pid, "[mock:rules] Follow the rules");
const install = ruled.tools.find((t) => t.name === "run_command");
check("matching command is blocked", install?.output?.ok === false && /Blocked by a project rule/.test(install.output.text), install?.output?.text?.slice(0, 70));
const notes = ruled.tools.find((t) => t.input?.path === "src/notes.txt");
check("after-change rule runs on the file", /formatted src\/notes\.txt/.test(notes?.output?.text ?? ""));
check("failing before-finish rule fails the check", ruled.checks[0]?.status === "failed");
check("check passes once the rule passes", ruled.checks.at(-1)?.status === "passed" && ruled.checks.at(-1)?.rules === true, JSON.stringify(ruled.checks));

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
