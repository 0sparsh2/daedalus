// UI rules audit for the real app (the ui-ux-pro-max checks used on the prototype): contrast,
// accessible names, labels, target sizes, tiny text, headings, duplicate ids, overflow.
// Reuses inPage() from wireframes/tests/rules-audit.js. Needs the dev server + local Supabase.
// Usage: node tests/e2e/rules-audit.mjs [baseUrl]
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://localhost:3100";
const auditSrc = readFileSync(fileURLToPath(new URL("../../../wireframes/tests/rules-audit.js", import.meta.url)), "utf8");
const inPageSrc = auditSrc.slice(auditSrc.indexOf("function inPage(touch) {"), auditSrc.indexOf("\n(async () => {"));

// Seed: a user with a mock key and a project that has a plan run and a build run.
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const email = `audit+${Date.now()}@daedalus.test`;
const password = "audit-password-123";
await admin.auth.admin.createUser({ email, password, email_confirm: true });
const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const { data } = await anon.auth.signInWithPassword({ email, password });
const auth = { authorization: `Bearer ${data.session.access_token}`, "content-type": "application/json" };
await fetch(`${BASE}/api/credentials`, { method: "POST", headers: auth, body: JSON.stringify({ provider: "mock", apiKey: "mock-key-for-tests", model: "mock-builder" }) });
const drain = async (res) => {
  await res.text();
};
let projectId;
for (const [text, mode] of [
  ["[mock:plan] A booking app for a small clinic", "plan"],
  ["[mock:broken] Build the first screen", "build"],
]) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ projectId, message: { id: `u-${Date.now()}`, role: "user", parts: [{ type: "text", text }] }, mode }),
  });
  projectId = res.headers.get("x-daedalus-project-id");
  await drain(res);
}
console.log("seeded project", projectId);

const login = async (p) => {
  await p.goto(BASE);
  await p.getByRole("button", { name: "Sign in" }).click();
  const d = p.getByRole("dialog");
  await d.getByLabel("Email").fill(email);
  await d.getByLabel("Password").fill(password);
  await d.getByRole("button", { name: "Sign in" }).click();
  await d.waitFor({ state: "detached" });
};

// On phones the workspace shows one pane at a time; switch to the panel before using its tabs.
const panel = async (p) => {
  const sw = p.getByRole("group", { name: "View" }).getByRole("button", { name: "Preview" });
  if (await sw.isVisible().catch(() => false)) await sw.click();
};
const SCREENS = [
  ["home-out", async (p) => { await p.goto(BASE); }, false],
  ["signin", async (p) => { await p.goto(BASE); await p.getByLabel("Describe what you want to build").fill("A habit tracker"); await p.getByRole("button", { name: "Send" }).click(); await p.getByRole("dialog").waitFor(); }, false],
  ["home-in", async (p) => { await p.goto(BASE); await p.getByText("Your projects").waitFor(); }, true],
  ["connect", async (p) => { await p.goto(BASE); await p.getByRole("button", { name: "Account menu" }).click(); await p.getByText("Manage model keys").click(); await p.getByRole("dialog").waitFor(); }, true],
  ["import", async (p) => { await p.goto(BASE); await p.getByRole("button", { name: "Import from GitHub" }).click(); await p.getByRole("dialog").waitFor(); }, true],
  ["ws-chat", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await p.getByRole("region", { name: "Proposed plan" }).waitFor(); }, true],
  ["ws-trace", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await panel(p); await p.getByRole("tab", { name: "Trace" }).click(); await p.getByRole("listbox", { name: "Spans" }).getByText("Automatic check #1").waitFor(); await p.getByRole("listbox", { name: "Spans" }).getByText("mock-builder").first().click(); }, true],
  ["ws-code", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await panel(p); await p.getByRole("tab", { name: "Code" }).click(); await p.getByRole("navigation", { name: "Project files" }).waitFor(); }, true],
  ["ws-plan", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await panel(p); await p.getByRole("tab", { name: "Plan" }).click(); await p.waitForTimeout(300); }, true],
  ["ws-agents", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await panel(p); await p.getByRole("tab", { name: "Agents" }).click(); await p.getByText("Who works on this project").waitFor(); await p.locator("#agents-md").waitFor(); }, true],
  ["ws-versions", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await p.getByRole("button", { name: /Versions/ }).click(); await p.waitForTimeout(200); }, true],
  ["ws-ship", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await p.getByRole("button", { name: /Ship/ }).click(); await p.waitForTimeout(600); }, true],
  ["ws-model", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await p.locator(".composer .chip").first().click(); await p.waitForTimeout(200); }, true],
  ["account", async (p) => { await p.goto(`${BASE}/p/${projectId}`); await p.getByRole("button", { name: "Account menu" }).click(); await p.waitForTimeout(200); }, true],
];
const CTX = [
  ["desk-light", { viewport: { width: 1440, height: 900 }, colorScheme: "light" }],
  ["desk-dark", { viewport: { width: 1440, height: 900 }, colorScheme: "dark" }],
  ["ph-375", { viewport: { width: 375, height: 812 }, colorScheme: "light", hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
  ["ph-375-dark", { viewport: { width: 375, height: 812 }, colorScheme: "dark", hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
];

const b = await chromium.launch();
const report = {};
const errs = [];
for (const [cn, opts] of CTX) {
  for (const signedIn of [false, true]) {
    const c = await b.newContext(opts);
    const p = await c.newPage();
    p.on("pageerror", (e) => errs.push(`${cn}: ${e.message}`));
    if (signedIn) await login(p);
    for (const [sn, go, needsAuth] of SCREENS) {
      if (needsAuth !== signedIn) continue;
      try {
        await go(p);
        await p.waitForTimeout(250);
        report[`${cn}/${sn}`] = await p.evaluate(`(${inPageSrc})(${Boolean(opts.hasTouch)})`);
      } catch (e) {
        report[`${cn}/${sn}`] = { error: String(e.message).split("\n")[0] };
      }
    }
    await c.close();
  }
}
await b.close();

const agg = {};
const add = (k, v, where) => {
  agg[k] ??= {};
  agg[k][v] ??= new Set();
  agg[k][v].add(where);
};
for (const [w, r] of Object.entries(report)) {
  if (r.error) {
    add("ERROR", r.error, w);
    continue;
  }
  for (const k of ["contrast", "noname", "nolabel", "small", "tiny", "inputBorder", "headings"]) for (const v of r[k]) add(k, v, w);
  if (r.dupIds.length) add("dupIds", r.dupIds.join(","), w);
  if (r.menuRole) add("menuRole", "role=menu/menuitem present", w);
  if (r.overflow > 0) add("overflow", `${r.overflow}px`, w);
}
console.log(`screens audited: ${Object.keys(report).length}`);
for (const [k, m] of Object.entries(agg)) {
  console.log(`\n## ${k}: ${Object.keys(m).length} distinct`);
  for (const [v, s] of Object.entries(m).slice(0, 30)) console.log(`  - ${v}  ⟵ ${[...s].slice(0, 3).join(", ")}${s.size > 3 ? ` +${s.size - 3}` : ""}`);
}
console.log("\npage errors:", errs.length ? errs.slice(0, 5) : "none");
