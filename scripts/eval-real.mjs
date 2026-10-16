// Golden-task evals on a real model: build the app through the whole pipeline (smoke-real),
// then score the result with the task's acceptance test. Use it to measure prompt and harness
// changes instead of eyeballing them. Reads TEST_NVIDIA_API_KEY (via smoke-real); never prints it.
// Usage: node scripts/eval-real.mjs [model] [runs] [baseUrl]
import { spawnSync } from "node:child_process";

const MODEL = process.argv[2] ?? "nvidia/nemotron-3-super-120b-a12b";
const RUNS = Number(process.argv[3] ?? 1);
const BASE = process.argv[4] ?? "http://localhost:3100";
const TASKS = [
  {
    name: "habit-tracker",
    prompt: "Build a habit tracker: add and remove habits, tick a habit off for today, show a streak count per habit, and keep everything in localStorage.",
    accept: "tests/evals/habit-tracker.mjs",
  },
];

const rows = [];
for (const task of TASKS) {
  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`${task.name} #${i} on ${MODEL}: building… `);
    const build = spawnSync("node", ["scripts/smoke-real.mjs", task.prompt, MODEL, "build", BASE], { encoding: "utf8", env: process.env });
    const summary = JSON.parse(build.stdout.trim().split("\n").pop() || "{}");
    if (!summary.previewUrl || summary.status !== "succeeded") {
      console.log(`run ${summary.status ?? "crashed"}`);
      rows.push({ task: task.name, run: i, status: summary.status ?? "crashed", score: "0" });
      continue;
    }
    const accept = spawnSync("node", [task.accept, summary.previewUrl, `test-results/eval-${task.name}-${i}`], { encoding: "utf8" });
    const fails = accept.stdout.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.slice(6));
    const score = accept.stdout.match(/(\d+\/\d+) passed/)?.[1] ?? "error";
    console.log(`${score} in ${summary.seconds}s`);
    for (const f of fails) console.log(`    ✗ ${f}`);
    rows.push({ task: task.name, run: i, status: summary.status, score, seconds: summary.seconds, calls: summary.llmCalls, tools: summary.toolCalls, tokens: `${summary.inputTokens}/${summary.outputTokens}` });
  }
}
console.table(rows);
