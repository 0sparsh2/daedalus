// Renders docs/architecture.svg to docs/architecture.png at 2x. Usage: node scripts/render-diagram.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const svg = readFileSync(fileURLToPath(new URL("../docs/architecture.svg", import.meta.url)), "utf8");
const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><head><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet"><style>html,body{margin:0;background:#FBFBF9}</style></head><body>${svg}</body></html>`);
await page.waitForTimeout(1200);
await page.screenshot({ path: fileURLToPath(new URL("../docs/architecture.png", import.meta.url)), clip: { x: 0, y: 0, width: +w, height: +h } });
await browser.close();
console.log("wrote docs/architecture.png");
