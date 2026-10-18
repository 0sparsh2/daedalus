// Removes local Docker sandboxes that belong to test accounts (emails ending @daedalus.test),
// which the smoke and eval scripts create one per project. Your own projects are never touched.
// Usage: node --env-file=.env.development.local scripts/clean-test-sandboxes.mjs [--dry-run]
import { createClient } from "@supabase/supabase-js";
import { execFileSync } from "node:child_process";

const dry = process.argv.includes("--dry-run");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const lines = execFileSync("docker", ["ps", "-a", "--filter", "label=daedalus=1", "--format", '{{.Names}} {{.Label "daedalus.project"}}'], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const rows = lines.map((l) => l.split(" "));
const { data: projects } = await db.from("projects").select("id,user_id").in("id", rows.map((r) => r[1]));
const emails = new Map();
for (let page = 1; ; page++) {
  const { data } = await db.auth.admin.listUsers({ page, perPage: 200 });
  for (const u of data.users) emails.set(u.id, u.email ?? "");
  if (data.users.length < 200) break;
}
const ownerOf = new Map((projects ?? []).map((p) => [p.id, emails.get(p.user_id) ?? ""]));
const test = rows.filter(([, pid]) => ownerOf.get(pid)?.endsWith("@daedalus.test")).map(([name]) => name);
console.log(`${rows.length} sandboxes; ${test.length} belong to test accounts${dry ? " (dry run)" : ""}`);
for (let i = 0; !dry && i < test.length; i += 20) execFileSync("docker", ["rm", "-f", ...test.slice(i, i + 20)], { stdio: "ignore" });
