// The whole product with a real model, in a browser, the way a person uses it: describe an app,
// sign up when Send is pressed, connect an NVIDIA NIM key, get a researched plan, start building,
// and check the finished app in the preview. Works against local or deployed Daedalus.
// Usage: TEST_NVIDIA_API_KEY=… node tests/e2e/real-flow.mjs [baseUrl] [prompt]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3100";
const PROMPT =
  process.argv[3] ??
  "A weather dashboard: search a city, show today's conditions and a 7-day forecast, using the free Open-Meteo API (no key). Research Open-Meteo's geocoding and forecast endpoints first.";
const KEY = process.env.TEST_NVIDIA_API_KEY;
if (!KEY) throw new Error("TEST_NVIDIA_API_KEY is not set");
const OUT = process.env.SHOTS ?? "test-results/real-flow";
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(BASE);
await page.getByLabel("Describe what you want to build").fill(PROMPT);
await page.getByRole("button", { name: "Send" }).click();
const dialog = page.getByRole("dialog");
await dialog.getByRole("heading", { name: "Sign in to start building" }).waitFor();
await dialog.getByRole("button", { name: "New here? Create an account" }).click();
await dialog.getByLabel("Email").fill(`real-ui+${Date.now()}@daedalus.test`);
await dialog.getByLabel("Password").fill("real-ui-password-123");
await dialog.getByRole("button", { name: "Create account" }).click();
await dialog.getByRole("heading", { name: "Connect a model" }).waitFor();
log("signed up on Send; connect-a-model step shown");

// NVIDIA NIM is the default provider and Nemotron 3 Super its default model.
await dialog.getByLabel(/API key/).fill(KEY);
await dialog.getByRole("button", { name: "Check key and continue" }).click();
await page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 90_000 });
log("key checked; workspace:", page.url().replace(BASE, ""));

// Plan mode: watch for the research sub-agent, then the plan card.
const subagent = page.locator(".subagent").filter({ hasText: "Research sub-agent" }).first();
await subagent.waitFor({ timeout: 180_000 }).then(() => log("research sub-agent card shown"), () => log("no research sub-agent card seen"));
const plan = page.getByRole("region", { name: "Proposed plan" });
await plan.waitFor({ timeout: 600_000 });
await page.screenshot({ path: `${OUT}/01-plan.png`, fullPage: true });
log("plan:", (await plan.innerText()).replace(/\s+/g, " ").slice(0, 220));

await plan.getByRole("button", { name: /Start building/ }).click();
log("start building");
await page.getByText(/Saved version|stopped because of an error|Stopped\./).first().waitFor({ timeout: 900_000 });
const ended = (await page.getByText(/Saved version|stopped because of an error|Stopped\./).first().innerText()).slice(0, 160);
log("run ended:", ended);
const checks = await page.getByText(/Automatic check/).allInnerTexts();
log("automatic checks:", checks.map((c) => c.replace(/\s+/g, " ").slice(0, 90)).join(" | ") || "none shown");
await page.screenshot({ path: `${OUT}/02-built.png`, fullPage: true });

// The preview, as the user sees it.
const frame = page.frameLocator('iframe[title="App preview"]');
await frame.locator("body").waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);
const previewText = (await frame.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
log("preview text:", previewText || "(empty)");
const input = frame.locator('input[type="text"], input[type="search"], input:not([type])').first();
if (await input.count()) {
  await input.fill("Berlin");
  await input.press("Enter");
  await page.waitForTimeout(6000);
  log("after searching Berlin:", (await frame.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300));
}
await page.locator('iframe[title="App preview"]').screenshot({ path: `${OUT}/03-preview.png` });

// The trace for the plan run, opened from the research card's own Trace button.
const researchCard = page.locator(".subagent").filter({ hasText: "Research sub-agent" }).first();
if (await researchCard.count()) {
  await researchCard.getByRole("button", { name: "Trace" }).click();
  await page.waitForTimeout(2500);
  const trace = (await page.locator("#panel-trace").innerText().catch(() => "")).replace(/\s+/g, " ");
  log("plan-run trace has the sub-agent:", /sub-agent/i.test(trace), "· web_search:", /web_search/.test(trace), "· web_fetch:", /web_fetch/.test(trace));
  await page.screenshot({ path: `${OUT}/04-trace.png`, fullPage: true });
}
// Errors from the preview mid-build are expected (the agent fixes them); report them separately.
log(errors.length ? `page errors: ${errors.slice(0, 3).join(" | ")}` : "no page errors");
await browser.close();
