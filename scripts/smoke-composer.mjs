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
// Next's dev tools badge can sit on top of the composer in dev; it isn't part of the product.
await page.addInitScript(() => {
  const hide = () => {
    const style = document.createElement("style");
    style.textContent = "nextjs-portal { display: none !important; }";
    document.documentElement?.appendChild(style);
  };
  if (document.documentElement) hide();
  else document.addEventListener("DOMContentLoaded", hide);
});

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
// Suggested skills and rules: cards in the chat, applied only on Add
await page.getByRole("group", { name: "Run mode" }).getByRole("button", { name: "Build" }).click();
await box.fill("[mock:suggest] Learn from this");
await box.press("Escape");
await box.press("Enter");
const ruleCard = page.getByRole("group", { name: "Suggested rule: Type check before finishing" });
await ruleCard.waitFor({ timeout: 180_000 });
await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 180_000 });
const skillCard = page.getByRole("group", { name: "Suggested skill: date-handling" });
check("suggestion cards show in the chat", (await skillCard.isVisible()) && (await ruleCard.innerText()).includes("Before finishing a change, run npx tsc --noEmit"));
check("a refused suggestion shows no card", (await page.getByRole("group", { name: /Suggested rule: Broken rule/ }).count()) === 0);
await ruleCard.getByRole("button", { name: "Add rule" }).click();
await ruleCard.getByText("Added to Rules").waitFor({ timeout: 20_000 });
await skillCard.getByRole("button", { name: "Add skill" }).click();
await skillCard.getByText("Added to Skills").waitFor({ timeout: 60_000 });
await page.getByRole("tab", { name: "Customize" }).click();
await page.getByRole("group", { name: "Customize sections" }).getByRole("button", { name: "Rules that always run" }).click();
check("an added rule shows in Rules right away", await page.getByText("Type check before finishing").first().isVisible({ timeout: 10_000 }).catch(() => false));
await page.screenshot({ path: `${OUT}/05-suggestions.png` });

// Review: /review in the message box, and the button in Customize → Improve
await box.fill("/review [mock:review]");
await box.press("Escape");
await box.press("Enter");
const reviewReply = page.locator(".msg-ai").last();
await reviewReply.getByText(/Reviewed \d+ runs/).waitFor({ timeout: 180_000 });
check("/review starts a review turn", (await reviewReply.locator(".route-chip").first().innerText()).includes("Review"), await reviewReply.locator(".route-chip").first().innerText());
check("the review's suggestion shows as a card", await reviewReply.getByRole("group", { name: "Suggested rule: Lint before finishing" }).isVisible());
const lastUser = await page.locator(".msg-user").last().innerText();
check("the command itself isn't sent", !lastUser.includes("/review"), lastUser);
await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 60_000 });
await page.getByRole("tab", { name: "Customize" }).click();
await page.getByRole("group", { name: "Customize sections" }).getByRole("button", { name: "Improve" }).click();
const improve = page.getByRole("region", { name: "Suggestions" }).or(page.locator("section[aria-labelledby=sugg-h]"));
await improve.getByRole("group", { name: "Suggested rule: Lint before finishing" }).waitFor({ timeout: 20_000 });
check("Improve lists pending and added suggestions", (await improve.getByText("Added to Rules").count()) >= 1);
await page.screenshot({ path: `${OUT}/06-improve.png` });
await page.getByRole("button", { name: "Review recent runs" }).click();
await page.locator(".msg-user").last().getByText("Review my recent runs").waitFor({ timeout: 30_000 });
await page.locator(".msg-ai").last().locator(".route-chip").first().waitFor({ timeout: 120_000 });
check("the Improve button starts a review", (await page.locator(".msg-ai").last().locator(".route-chip").first().innerText()).includes("Review"));
await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 180_000 });

// Connection permissions: the per-tool select, then an approval card in the chat
await page.getByRole("tab", { name: "Customize" }).click();
await page.getByRole("group", { name: "Customize sections" }).getByRole("button", { name: "Connections" }).click();
await page.getByLabel("Name").fill("deepwiki");
await page.getByLabel("Server address").fill("https://mcp.deepwiki.com/mcp");
await page.getByRole("button", { name: /Connect and list its tools/ }).click();
await page.getByRole("button", { name: "Tools and permissions" }).first().click({ timeout: 60_000 });
const perm = page.getByLabel("Permission for read_wiki_structure");
check("each tool has a permission, defaulting to Ask for unannotated tools", (await perm.inputValue()) === "default" && (await perm.locator("option:checked").innerText()).includes("Ask each time"), await perm.locator("option:checked").innerText());
await page.screenshot({ path: `${OUT}/07-permissions.png` });
await page.getByRole("group", { name: "Run mode" }).getByRole("button", { name: "Build" }).click();
await box.fill("[mock:mcp-build] Read the wiki");
await box.press("Escape");
await box.press("Enter");
const approval = page.getByRole("group", { name: "Approve deepwiki read_wiki_structure" });
await approval.waitFor({ timeout: 120_000 });
check("an ask tool shows an approval card with its arguments", (await approval.innerText()).includes("vercel/ai"));
await page.screenshot({ path: `${OUT}/08-approval.png` });
await approval.getByRole("button", { name: "Allow once" }).click();
await page.getByText(/read_wiki_structure: Allowed once/).waitFor({ timeout: 120_000 });
await page.getByRole("button", { name: "Send" }).waitFor({ timeout: 120_000 });
check("Allow once lets the run carry on", (await page.locator(".msg-ai").last().innerText()).includes("Got it"));

check("no page errors", errors.length === 0, errors.join(" | ").slice(0, 200));

await browser.close();
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
