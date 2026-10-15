// Browser end-to-end flow against a running dev server + local Supabase + Docker sandbox,
// using the scripted mock model. Usage: node tests/e2e/ui-flow.mjs [baseUrl]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.env.SHOTS ?? "test-results/ui-flow";
mkdirSync(OUT, { recursive: true });
const email = `ui+${Date.now()}@daedalus.test`;
const password = "ui-test-password-123";
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE);
await page.getByRole("heading", { name: "What do you want to build?" }).waitFor();
await page.screenshot({ path: `${OUT}/01-home.png` });
log("home loaded");

// 1. Send while signed out → sign-in dialog appears.
await page.getByLabel("Describe what you want to build").fill("[mock:plan] A booking app for a small clinic");
await page.getByRole("button", { name: "Send" }).click();
const dialog = page.getByRole("dialog");
await dialog.getByRole("heading", { name: "Sign in to start building" }).waitFor();
await page.screenshot({ path: `${OUT}/02-signin.png` });
log("sign-in dialog opened on Send");

// 2. Create an account.
await dialog.getByRole("button", { name: "New here? Create an account" }).click();
await dialog.getByLabel("Email").fill(email);
await dialog.getByLabel("Password").fill(password);
await dialog.getByRole("button", { name: "Create account" }).click();
await dialog.getByRole("heading", { name: "Connect a model" }).waitFor();
await page.screenshot({ path: `${OUT}/03-connect-model.png` });
log("signed up; connect-a-model step shown");

// 3. Bad key format for NIM is rejected, then connect the mock provider.
await dialog.getByLabel(/API key/).fill("not-a-real-key-123");
await dialog.getByRole("button", { name: "Check key and continue" }).click();
await dialog.getByRole("alert").waitFor();
log("bad key rejected:", (await dialog.getByRole("alert").textContent())?.slice(0, 80));
await dialog.getByRole("button", { name: /Mock \(tests\)/ }).click();
await dialog.getByLabel(/API key/).fill("mock-key-for-tests");
await dialog.getByRole("button", { name: "Check key and continue" }).click();

// 4. Project created, workspace opens, first message auto-sent in plan mode.
await page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 30_000 });
log("workspace:", page.url());
await page.getByRole("region", { name: "Proposed plan" }).waitFor({ timeout: 90_000 });
await page.screenshot({ path: `${OUT}/04-plan.png` });
log("plan card shown");

// 5. Build: switch to Build mode and send a scripted build turn.
await page.getByRole("button", { name: "Build", exact: true }).first().click();
await page.getByLabel("Message Daedalus").fill("[mock:broken] Build the first screen");
await page.getByRole("button", { name: "Send" }).click();
await page.getByText(/Automatic check found/).waitFor({ timeout: 120_000 });
log("automatic check caught the broken build");
await page.getByText(/Saved version/).waitFor({ timeout: 120_000 });
await page.screenshot({ path: `${OUT}/05-built.png` });
log("build finished with a saved version");

// 6. Preview iframe renders the app.
const frame = page.frameLocator('iframe[title="App preview"]');
await frame.getByText("Hello from Daedalus").waitFor({ timeout: 60_000 });
log("preview shows the built app");

// 7. Code tab lists files and shows App.tsx.
await page.getByRole("tab", { name: "Code" }).click();
await page.getByRole("navigation", { name: "Project files" }).getByRole("button", { name: "App.tsx" }).waitFor({ timeout: 30_000 });
await page.screenshot({ path: `${OUT}/06-code.png` });
log("code tab ok");

// 8. Trace tab shows spans including llm and verify.
await page.getByRole("tab", { name: "Trace" }).click();
await page.getByRole("listbox", { name: "Spans" }).getByText("Automatic check #1").waitFor({ timeout: 30_000 });
await page.getByRole("listbox", { name: "Spans" }).getByText("mock-builder").first().click();
await page.screenshot({ path: `${OUT}/07-trace.png` });
log("trace tab ok");

// 9. Reload: conversation persists.
await page.reload();
await page.getByText("Build the first screen").waitFor({ timeout: 30_000 });
await page.getByRole("region", { name: "Proposed plan" }).waitFor();
log("reload keeps the conversation");

// 10. Phone layout.
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${OUT}/08-phone.png` });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
log("phone horizontal overflow px:", overflow);

console.log(errors.length ? `console errors (${errors.length}):\n${errors.slice(0, 10).join("\n")}` : "no console errors");
await browser.close();
