// Security smoke test against a running dev server (scripted model): secret redaction in what's
// stored, trace retention, per-tool connection permissions and sandbox isolation.
// Usage: node --env-file=.env.development.local scripts/smoke-security.mjs [baseUrl]
import { createClient } from "@supabase/supabase-js";

const BASE = process.argv[2] ?? "http://localhost:3100";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = `security+${Date.now()}@daedalus.test`;
await admin.auth.admin.createUser({ email, password: "security-test-123", email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email, password: "security-test-123" });
const auth = { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" };
const call = async (method, path, json, headers = auth) => {
  const r = await fetch(`${BASE}${path}`, { method, headers, body: json ? JSON.stringify(json) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` · ${extra}` : ""}`);
};

/** Runs one turn; returns tool calls with outputs, the text, the run id and data parts. */
async function turn(projectId, text, mode = "build", onApproval) {
  const res = await fetch(`${BASE}/api/chat`, { method: "POST", headers: auth, body: JSON.stringify({ projectId, message: { id: `u-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: "user", parts: [{ type: "text", text }] }, mode }) });
  const out = { projectId: res.headers.get("x-daedalus-project-id"), runId: res.headers.get("x-daedalus-run-id"), tools: [], said: "", data: [] };
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
      if (e.type === "tool-input-available") names.set(e.toolCallId, { name: e.toolName, input: e.input, id: e.toolCallId });
      if (e.type === "tool-output-available") out.tools.push({ ...names.get(e.toolCallId), output: e.output });
      if (e.type === "tool-output-error" || e.type === "tool-input-error") out.tools.push({ ...names.get(e.toolCallId), error: e.errorText });
      if (e.type === "text-delta") out.said += e.delta;
      if (e.type?.startsWith("data-")) out.data.push(e);
      if (e.type === "data-approval" && e.data?.status === "waiting" && onApproval) void onApproval(out.runId, e.data);
    }
  }
  return out;
}

await call("POST", "/api/credentials", { provider: "mock", apiKey: "mock-key-for-tests", model: "mock-builder" });
const first = await turn(undefined, "[mock:hello] Start the project");
const pid = first.projectId;
check("project started", Boolean(pid));

// 1. Redaction: the model sees the key during the run; stored copies don't keep it.
const KEY = ["nv", "api-", "Zq7Lm2Xc9Vb4Nn6Kk1Pp3Rr5Tt8Ww0Yy2Aa"].join("");
const echo = await turn(pid, `[mock:secret-echo] My key is ${KEY}, print the config`);
const cmd = echo.tools.find((t) => t.name === "run_command");
check("the model sees the key during the run", String(cmd?.output?.text ?? "").includes(KEY));
const { data: spans } = await admin.from("spans").select("input,output,error,attrs").eq("run_id", echo.runId);
const spanText = JSON.stringify(spans ?? []);
check("trace spans don't store the key", spans?.length > 0 && !spanText.includes(KEY) && spanText.includes("[REDACTED]"), `${spans?.length} spans`);
const { data: msgs } = await admin.from("messages").select("role,parts").eq("project_id", pid);
const msgText = JSON.stringify(msgs ?? []);
check("saved messages don't store the key (the user's message included)", !msgText.includes(KEY) && msgText.includes("[REDACTED]"));
const { data: runRow } = await admin.from("runs").select("summary,error").eq("id", echo.runId).single();
check("run summary and error don't store it", !JSON.stringify(runRow).includes(KEY));
const rem = (await turn(pid, "[mock:remember-secret] Remember my key")).tools.find((t) => t.name === "remember");
check("a memory holding a key is refused", rem?.output?.ok === false && /secret|key/i.test(rem.output.text), rem?.output?.text?.slice(0, 90));
const manual = await call("POST", `/api/projects/${pid}/memories`, { text: `Use ${KEY} for weather`, scope: "project" });
check("a memory you add with a key is refused too", manual.status === 400 && manual.body?.error?.code === "contains_secret", manual.body?.error?.message);

// 2. Retention: old span details are cleared; active projects and recent spans are left alone.
const second = await turn(undefined, "[mock:hello] Another project");
const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
await admin.from("spans").update({ started_at: old }).eq("run_id", first.runId);
await admin.from("spans").update({ started_at: old }).eq("run_id", second.runId);
// The second project has a run in progress, so its spans must be skipped.
const { data: busy } = await admin.from("runs").insert({ project_id: second.projectId, user_id: (await admin.from("projects").select("user_id").eq("id", second.projectId).single()).data.user_id, mode: "build", provider: "mock", model: "mock-builder", status: "running" }).select("id").single();
const noAuth = await call("GET", "/api/cron/retention", null, {});
check("the cleanup route refuses without the cron secret", noAuth.status === 401, String(noAuth.status));
const sweep = await call("GET", "/api/cron/retention", null, { authorization: `Bearer ${process.env.CRON_SECRET}` });
check("the cleanup route runs with it", sweep.status === 200 && sweep.body?.cleared > 0 && sweep.body?.days === 30, JSON.stringify(sweep.body));
const { data: aged } = await admin.from("spans").select("input,output,pruned_at,name,duration_ms").eq("run_id", first.runId);
check("old spans keep their row but lose input and output", aged.length > 0 && aged.every((s) => s.pruned_at && s.input === null && s.output === null && s.name), `${aged.length} spans`);
const { data: skipped } = await admin.from("spans").select("pruned_at").eq("run_id", second.runId);
check("projects with a run in progress are skipped", skipped.length > 0 && skipped.every((s) => !s.pruned_at));
const { data: fresh } = await admin.from("spans").select("pruned_at").eq("run_id", echo.runId);
check("recent spans are kept whole", fresh.every((s) => !s.pruned_at));
const { count: msgCount } = await admin.from("messages").select("id", { count: "exact", head: true }).eq("project_id", pid);
check("messages are never deleted", msgCount === (msgs?.length ?? 0) + 2, `${msgCount}`);
await admin.from("runs").update({ status: "failed", ended_at: new Date().toISOString() }).eq("id", busy.id);

// 3. Per-tool permissions for connections: allow / ask / block, and the approval flow.
const conn = await call("POST", `/api/projects/${pid}/connections`, { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp" });
check("connected a server whose tools carry no annotations", conn.body?.ok === true, JSON.stringify(conn.body).slice(0, 80));
const toolOf = (r) => r.tools.find((t) => t.name === "mcp__deepwiki__read_wiki_structure");
const approvalsOf = (r) => r.data.filter((e) => e.type === "data-approval").map((e) => e.data.status);
const answer = (decision) => async (runId, d) => {
  await new Promise((r) => setTimeout(r, 300));
  await call("POST", `/api/runs/${runId}/approvals`, { toolCallId: d.toolCallId, decision });
};
const denied = await turn(pid, "[mock:mcp-build] Read the wiki", "build", answer("denied"));
check("a tool without annotations asks first, and Deny stops the call", approvalsOf(denied).join(",") === "waiting,denied" && toolOf(denied)?.output?.ok === false && toolOf(denied)?.output?.approval === "denied", `${approvalsOf(denied)} · ${toolOf(denied)?.output?.text?.slice(0, 60)}`);
const once = await turn(pid, "[mock:mcp-build] Read the wiki", "build", answer("approved"));
check("Allow once makes the call", approvalsOf(once).join(",") === "waiting,approved" && toolOf(once)?.output?.ok === true && toolOf(once)?.output?.approval === "approved", toolOf(once)?.output?.text?.slice(0, 60));
const always = await turn(pid, "[mock:mcp-build] Read the wiki", "build", answer("always"));
const policies = (await call("GET", `/api/projects/${pid}/connections`)).body?.connections?.[0]?.tool_policies ?? {};
check("Always allow saves the tool's permission", toolOf(always)?.output?.ok === true && policies.read_wiki_structure === "allow", JSON.stringify(policies));
const free = await turn(pid, "[mock:mcp-build] Read the wiki", "build");
check("an allowed tool runs without asking", approvalsOf(free).length === 0 && toolOf(free)?.output?.ok === true);
await call("PATCH", `/api/projects/${pid}/connections`, { id: conn.body.id, toolPolicies: { read_wiki_structure: "block" } });
const blocked = await turn(pid, "[mock:mcp-build] Read the wiki", "build");
check("a blocked tool isn't offered at all", approvalsOf(blocked).length === 0 && !toolOf(blocked)?.output?.ok, (toolOf(blocked)?.error ?? toolOf(blocked)?.output?.text ?? "").slice(0, 80));
await call("PATCH", `/api/projects/${pid}/connections`, { id: conn.body.id, toolPolicies: { read_wiki_structure: "default" } });
const stopped = await turn(pid, "[mock:mcp-build] Read the wiki", "build", async (runId) => {
  await new Promise((r) => setTimeout(r, 300));
  await call("POST", `/api/runs/${runId}/stop`);
});
const { data: stopRow } = await admin.from("approvals").select("status").eq("run_id", stopped.runId).single();
const { data: stopRun } = await admin.from("runs").select("status").eq("id", stopped.runId).single();
check("Stop while waiting answers the approval and ends the run", stopRow?.status === "stopped" && stopRun?.status === "cancelled", `${stopRow?.status} · ${stopRun?.status}`);
const stranger = await call("POST", `/api/runs/${once.runId}/approvals`, { toolCallId: "not-a-real-call", decision: "approved" });
check("approvals can't be answered for calls that aren't waiting", stranger.status === 404, String(stranger.status));
const { data: planTools } = await admin.from("spans").select("name").eq("run_id", (await turn(pid, "[mock:mcp-plan] Plan with docs", "plan")).runId).like("name", "mcp__deepwiki%");
check("tools that may change things still aren't offered while planning", (planTools ?? []).length === 0);

// 4. Sandbox isolation: none of Daedalus's secrets reach the sandbox; the network allowlist.
const envOut = String((await turn(pid, "[mock:env-dump] Show the environment")).tools.find((t) => t.name === "run_command")?.output?.text ?? "");
const serverSecrets = ["SUPABASE_SECRET_KEY", "GATEWAY_TOKEN_SECRET", "CREDENTIALS_ENCRYPTION_KEY", "CRON_SECRET", "TEST_NVIDIA_API_KEY", "TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY", "VERCEL_TOKEN", "VERCEL_DEPLOY_TOKEN", "GITHUB_CLIENT_SECRET"];
const leaked = serverSecrets.filter((k) => envOut.includes(`${k}=`) || (process.env[k] && process.env[k].length > 8 && envOut.includes(process.env[k])));
check("no server secret reaches the sandbox (commands or its main process)", envOut.includes("---") && envOut.length > 50 && leaked.length === 0, leaked.join(", ") || `${envOut.split("\n").length} lines checked`);
const net = await call("GET", `/api/projects/${pid}/network`);
check("the network allowlist starts with npm and GitHub", net.body?.defaults?.includes("registry.npmjs.org") && net.body?.defaults?.includes("github.com") && net.body?.enforced === false && net.body?.provider === "docker", JSON.stringify(net.body).slice(0, 120));
const badNet = await call("PUT", `/api/projects/${pid}/network`, { domains: ["localhost", "api.example.com"] });
check("local and invalid domains are refused", badNet.status === 400 && badNet.body?.error?.code === "bad_domain", badNet.body?.error?.message);
const goodNet = await call("PUT", `/api/projects/${pid}/network`, { domains: ["https://API.OpenWeatherMap.org/data", "*.supabase.co", "github.com"] });
check("added domains are normalized and saved", JSON.stringify(goodNet.body?.domains) === JSON.stringify(["api.openweathermap.org", "*.supabase.co"]) && goodNet.body?.applied === "unsupported", JSON.stringify(goodNet.body));

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
