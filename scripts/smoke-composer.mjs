// The composer in a browser with the scripted model: @ suggests project files, / suggests skills
// and commands, the + menu opens Customize at the right section, and the reply shows what the
// message loaded. Usage: node scripts/smoke-composer.mjs [baseUrl]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.env.SHOTS ?? "test-results/composer";
mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` · ${extra}` : ""}`);
};
const errors = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => errors.push(String(e)));

// Sign up on Send with the scripted model, which starts a project.
await page.goto(BASE);
await page.getByLabel("Describe what you want to build").fill("[mock:hello] Start the project");
await page.getByRole("button", { name: "Send" }).click();
const dialog = page.getByRole("dialog");
await dialog.getByRole("button", { name: "New here? Create an account" }).click();
await dialog.getByLabel("Email").fill(`composer+${Date.now()}@daedalus.test`);
await dialog.getByLabel("Password").fill("composer-password-123");
await dialog.getByRole("button", { name: "Create account" }).click();
await dialog.getByRole("heading", { name: "Connect a model" }).waitFor();
await dialog.locator(".provider-opt", { hasText: /mock|Scripted/i }).click();
const key = dialog.getByLabel(/API key/);
if (await key.isVisible().catch(() => false)) await key.fill("mock-key-for-tests");
await dialog.getByRole("button", { name: /continue/i }).click();
await page.waitForURL(/\/p\/[0-9a-f-]+/, { timeout: 90_000 });
await page.locator(".msg-ai").first().waitFor({ timeout: 120_000 });
await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 180_000 });

const box = page.getByLabel("Message Daedalus");
// @ → project files
await box.click();
await box.pressSequentially("Look at @App");
const list = page.getByRole("listbox", { name: "Project files" });
await list.waitFor({ timeout: 60_000 });
await page.getByRole("option").first().waitFor({ timeout: 60_000 });
const fileOpts = await page.getByRole("option").allInnerTexts();
check("@ suggests project files", fileOpts.some((o) => o.includes("src/App.tsx")), fileOpts.slice(0, 4).join(", "));
await page.screenshot({ path: `${OUT}/01-files.png` });
await box.press("Enter");
check("Enter picks the file instead of sending", (await box.inputValue()) === "Look at @src/App.tsx ", JSON.stringify(await box.inputValue()));

// / → skills and commands
await box.pressSequentially("and use /fo");
await page.getByRole("listbox", { name: "Skills and commands" }).getByRole("option").first().waitFor({ timeout: 60_000 });
const skillOpts = await page.getByRole("option").allInnerTexts();
check("/ suggests skills", skillOpts.some((o) => o.startsWith("/forms")), skillOpts.join(" | ").slice(0, 100));
await page.screenshot({ path: `${OUT}/02-skills.png` });
await box.press("Tab");
await box.press("Backspace");
await box.pressSequentially(" [mock:mention-echo]");
await box.press("Escape");
const sent = await box.inputValue();
check("Tab picks the skill", sent.includes("/forms [mock:mention-echo]"), JSON.stringify(sent));

// + menu → Customize sections
await page.getByRole("button", { name: "Add a file, skill or connection" }).click();
await page.screenshot({ path: `${OUT}/03-plus.png` });
await page.getByRole("button", { name: /Connections/ }).first().click();
check("+ → Connections opens Customize there", await page.getByRole("group", { name: "Customize sections" }).getByRole("button", { name: "Connections", pressed: true }).isVisible());
await page.getByRole("button", { name: "Add a file, skill or connection" }).click();
await page.getByRole("button", { name: /Rules that always run/ }).first().click();
check("+ → Rules opens the rules section", await page.getByRole("group", { name: "Customize sections" }).getByRole("button", { name: "Rules that always run", pressed: true }).isVisible());
await page.getByRole("button", { name: "Add a file, skill or connection" }).click();
await page.mouse.click(700, 120);
check("+ menu closes on a click elsewhere", !(await page.getByRole("button", { name: /Customize…/ }).isVisible()));

// Send: the bubble highlights mentions and the reply says what it loaded
await box.click();
await box.press("Enter");
const reply = page.locator(".msg-ai").last();
await reply.getByText(/SKILLS:/).waitFor({ timeout: 180_000 });
const said = await reply.innerText();
check("the run loaded the file and the skill", /src\/App\.tsx → 1: /.test(said) && /SKILLS: forms/.test(said), said.replace(/\s+/g, " ").slice(0, 140));
const marks = await page.locator(".msg-user").last().locator(".mention").allInnerTexts();
check("mentions are highlighted in the message", marks.join(",") === "@src/App.tsx,/forms", marks.join(","));
const chip = await reply.locator(".route-chip").allInnerTexts();
check("the reply shows what it used", chip.some((c) => c.includes("Using /forms, @App.tsx")), chip.join(" | "));
await page.screenshot({ path: `${OUT}/04-reply.png` });

// /plan alone switches the mode without sending
await page.getByRole("group", { name: "Run mode" }).getByRole("button", { name: "Build" }).click();
const userCount = await page.locator(".msg-user").count();
await box.fill("/plan");
await box.press("Escape");
await box.press("Enter");
check("/plan on its own switches to Plan first, without sending", (await page.getByRole("button", { name: "Plan first", pressed: true }).isVisible()) && (await box.inputValue()) === "" && (await page.locator(".msg-user").count()) === userCount);
check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
