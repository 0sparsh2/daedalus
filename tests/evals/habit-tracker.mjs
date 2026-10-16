// Golden-task eval: the habit-tracker request, checked against the generated app like a person
// would: add three habits, tick one, see a streak, reload, remove one, reload. Prints PASS/FAIL per
// step and a final "n/m passed" line. Usage: node tests/evals/habit-tracker.mjs <previewUrl> [shotPrefix]
import { chromium } from "@playwright/test";
const [url, out = "test-results/eval-habits"] = process.argv.slice(2);
const browser = await chromium.launch();
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` · ${extra}` : ""}`); };
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
const textInput = () => page.locator('input[type="text"], input:not([type]), input[type="search"]').first();
const names = ["Read 20 pages", "Morning run", "Drink 2L of water"];
for (const [i, name] of names.entries()) {
  const input = textInput();
  const present = await input.waitFor({ timeout: 4000 }).then(() => true, () => false);
  if (!present) { check(`add habit #${i + 1}: an input is on screen`, false); break; }
  await input.fill(name);
  await input.press("Enter");
  const shown = await page.getByText(name, { exact: true }).first().waitFor({ timeout: 1500 }).then(() => true, () => false);
  if (!shown) await page.getByRole("button", { name: /add/i }).first().click().catch(() => {});
  check(`add habit #${i + 1} "${name}"`, await page.getByText(name, { exact: true }).first().isVisible().catch(() => false));
}
// Tick the first habit: the first button in its card/row named like done/complete/mark/check/tick/toggle.
const row = page.locator("li, article, [class*='card'], [class*='rounded']").filter({ hasText: names[0] }).last();
const tick = row.getByRole("button", { name: /done|complete|mark|check|tick|today|toggle/i }).first();
const ticked = await tick.click({ timeout: 3000 }).then(() => true, () => false);
check("tick the first habit for today", ticked);
await page.waitForTimeout(300);
const rowText = async () => ((await row.innerText().catch(() => "")) || "").replace(/\s+/g, " ");
check("its streak shows 1", /\b1\b/.test(await rowText()), await rowText());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
const allThere = (await Promise.all(names.map((n) => page.getByText(n, { exact: true }).first().isVisible().catch(() => false)))).every(Boolean);
check("after reload: all habits are still there", allThere);
check("after reload: the streak is still 1", /\b1\b/.test(await rowText()), await rowText());
const row3 = page.locator("li, article, [class*='card'], [class*='rounded']").filter({ hasText: names[2] }).last();
const removed = await row3.getByRole("button", { name: /remove|delete/i }).first().click({ timeout: 3000 }).then(() => true, () => false);
await page.waitForTimeout(300);
check("remove a habit", removed && !(await page.getByText(names[2], { exact: true }).first().isVisible().catch(() => false)));
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(500);
check("after reload: the removed habit stays gone", !(await page.getByText(names[2], { exact: true }).first().isVisible().catch(() => false)));
check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));
await page.screenshot({ path: `${out}-desktop.png`, fullPage: true });
await page.setViewportSize({ width: 375, height: 760 });
await page.waitForTimeout(300);
check("phone: no horizontal overflow", !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
await page.screenshot({ path: `${out}-phone.png`, fullPage: true });
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
await browser.close();
