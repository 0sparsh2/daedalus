// Publishes the clickable product prototype (wireframes/) as public/prototype.html, so the
// live app can link to the designed flows that go beyond the real build.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const src = fileURLToPath(new URL("../../wireframes/architect2-prototype.html", import.meta.url));
const out = fileURLToPath(new URL("../public/prototype.html", import.meta.url));
let body;
try {
  body = readFileSync(src, "utf8");
} catch {
  console.log("prototype source not found; keeping the existing public/prototype.html");
  process.exit(0);
}
writeFileSync(
  out,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"></head><body>${body}</body></html>\n`,
);
console.log(`published prototype (${Math.round(body.length / 1024)} KB) to public/prototype.html`);
