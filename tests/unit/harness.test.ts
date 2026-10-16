import { describe, expect, it } from "vitest";
import { compactHistory, ledgerFor, versionTitle } from "@/lib/agent/history";
import { budgetNote, detectLoop, estimateTokens, pruneToolResults } from "@/lib/agent/loop";
import { fitToSchema, normalizeKeys, parseLooseJson, repairToolCall } from "@/lib/agent/repair";
import { stepsToParts } from "@/lib/agent/ui-parts";
import { pickTurn } from "@/lib/llm/mock-llm";
import { resolveInRoot } from "@/lib/sandbox/types";

describe("resolveInRoot", () => {
  it("keeps paths inside the app root", () => {
    expect(resolveInRoot("/workspace/app", "src/App.tsx")).toBe("/workspace/app/src/App.tsx");
    expect(resolveInRoot("/workspace/app", "./src/../index.html")).toBe("/workspace/app/index.html");
    expect(resolveInRoot("/workspace/app", "/workspace/app/src")).toBe("/workspace/app/src");
  });
  it("refuses escapes", () => {
    expect(() => resolveInRoot("/workspace/app", "../../etc/passwd")).toThrow(/outside the project/);
    expect(() => resolveInRoot("/workspace/app", "/etc/passwd")).toThrow(/outside the project/);
    expect(() => resolveInRoot("/workspace/app", "/workspace/app-evil/x")).toThrow(/outside the project/);
  });
});

describe("tool-call repair", () => {
  it("parses fenced and trailing-comma JSON", () => {
    expect(parseLooseJson('```json\n{"path": "a.ts",}\n```')).toEqual({ path: "a.ts" });
    expect(parseLooseJson('"{\\"command\\": \\"ls\\"}"')).toEqual({ command: "ls" });
    expect(parseLooseJson("not json")).toBeNull();
  });
  it("maps foreign key names", () => {
    expect(normalizeKeys("edit_file", { file_path: "a", oldString: "x", newString: "y" })).toEqual({ path: "a", old_string: "x", new_string: "y" });
    expect(normalizeKeys("research", { query: "vite 8" })).toEqual({ task: "vite 8" });
    expect(normalizeKeys("run_command", { command: ["npm", "i"], timeout: 120000 })).toEqual({ command: "npm i", timeout_seconds: 120 });
  });
  it("renames tools borrowed from other harnesses", async () => {
    const tools = { run_command: {}, edit_file: {}, update_todos: {} };
    const r = await repairToolCall({ toolCall: { toolCallId: "1", toolName: "bash", input: '{"cmd":"ls"}' }, tools, error: { name: "AI_NoSuchToolError" } });
    expect(r).toEqual({ type: "tool-call", toolCallId: "1", toolName: "run_command", input: '{"command":"ls"}' });
    const t = await repairToolCall({ toolCall: { toolCallId: "2", toolName: "TodoWrite", input: '{"todos":[]}' }, tools, error: { name: "AI_NoSuchToolError" } });
    expect(t?.toolName).toBe("update_todos");
    expect(await repairToolCall({ toolCall: { toolCallId: "3", toolName: "launch_rocket", input: "{}" }, tools, error: { name: "AI_NoSuchToolError" } })).toBeNull();
  });

  // Shapes as they arrive inside the durable step: the AI SDK schema object with its JSON schema.
  const todoItem = { type: "object", properties: { content: { type: "string" }, status: { type: "string" } }, required: ["content", "status"] };
  const todosSchema = { type: "object", properties: { todos: { type: "array", items: todoItem } }, required: ["todos"], additionalProperties: false };
  const runSchema = { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "integer" } }, required: ["command"], additionalProperties: false };
  const readSchema = { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" } }, required: ["path"], additionalProperties: false };

  it("fixes a misspelt key holding a JSON-encoded array (seen from Nemotron)", async () => {
    const todos = [{ content: "Build timer hook", status: "in_progress" }];
    const tools = { update_todos: { inputSchema: { jsonSchema: todosSchema } } };
    const r = await repairToolCall({
      toolCall: { toolCallId: "4", toolName: "update_todos", input: JSON.stringify({ tos: JSON.stringify(todos) }) },
      tools,
      error: { name: "AI_InvalidToolInputError" },
    });
    expect(r && JSON.parse(r.input)).toEqual({ todos });
  });

  it("fits inputs to the schema: near-miss keys, encoded numbers, stray fields", () => {
    expect(fitToSchema({ todo: [{ content: "a", status: "pending" }] }, todosSchema)).toEqual({ todos: [{ content: "a", status: "pending" }] });
    expect(fitToSchema({ command: "npm test", timeout_seconds: "90", explanation: "run tests" }, runSchema)).toEqual({ command: "npm test", timeout_seconds: 90 });
    expect(fitToSchema({ path: "src/App.tsx", offset: "20" }, readSchema)).toEqual({ path: "src/App.tsx", offset: 20 });
    // The only missing required key takes the only unknown key, but only if the type fits.
    expect(fitToSchema({ list: [{ content: "a", status: "pending" }] }, todosSchema)).toEqual({ todos: [{ content: "a", status: "pending" }] });
    expect(fitToSchema({ list: 42 }, todosSchema)).toEqual({});
    // Strings stay strings when the schema wants a string.
    expect(fitToSchema({ command: "[1,2]" }, runSchema)).toEqual({ command: "[1,2]" });
    expect(fitToSchema({ anything: 1 }, undefined)).toEqual({ anything: 1 });
    // Nested items are fitted too: a todo written as {task, state}.
    expect(fitToSchema({ todos: [{ task: "Ship it", status: "pending" }] }, todosSchema)).toEqual({ todos: [{ content: "Ship it", status: "pending" }] });
  });
});

describe("loop control", () => {
  const toolMsg = (n: number) => ({
    role: "tool" as const,
    content: [{ type: "tool-result" as const, toolCallId: `c${n}`, toolName: "read_file", output: { type: "text" as const, value: "x".repeat(1000) } }],
  });
  it("prunes all but the newest tool results", () => {
    const msgs = Array.from({ length: 12 }, (_, i) => toolMsg(i));
    const pruned = pruneToolResults(msgs, 8);
    const kept = pruned.filter((m) => m.role === "tool" && (m.content[0] as { output: { value: string } }).output.value.startsWith("x"));
    expect(kept).toHaveLength(8);
    expect(estimateTokens(pruned)).toBeLessThan(estimateTokens(msgs));
    const few = msgs.slice(0, 3);
    expect(pruneToolResults(few, 8)).toBe(few);
  });
  it("detects three identical tool calls in a row", () => {
    const same = { toolCalls: [{ toolName: "run_command", input: { command: "npm run build" } }] };
    expect(detectLoop([same, same])).toBeNull();
    expect(detectLoop([same, same, same])).toMatch(/three times/);
    expect(detectLoop([same, { toolCalls: [{ toolName: "read_file", input: { path: "a" } }] }, same])).toBeNull();
  });
  it("warns once near the step budget", () => {
    expect(budgetNote(66, 70)).toMatch(/4 steps left/);
    expect(budgetNote(65, 70)).toBeNull();
  });
});

describe("history compaction", () => {
  it("collapses earlier assistant turns to prose plus an action ledger", () => {
    const messages = [
      { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "Build a todo app" }] },
      {
        id: "a1",
        role: "assistant" as const,
        parts: [
          { type: "text", text: "Done." },
          { type: "tool-write_file", toolCallId: "t1", state: "output-available", input: { path: "src/App.tsx", content: "x".repeat(5000) }, output: { ok: true, text: "Created" } },
          { type: "tool-run_command", toolCallId: "t2", state: "output-available", input: { command: "npm install zustand" }, output: { ok: true, text: "added 1 package" } },
          { type: "tool-verify", toolCallId: "t3", state: "output-available", input: {}, output: { ok: true, text: "passed" } },
        ],
      },
      { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "Add dark mode" }] },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = compactHistory(messages as any);
    const a1 = out[1].parts.map((p) => (p as { text?: string }).text).join("\n");
    expect(a1).toContain("Done.");
    expect(a1).toContain("changed src/App.tsx");
    expect(a1).toContain("ran npm install zustand");
    expect(a1).toContain("verify passed");
    expect(a1).not.toContain("xxxxx");
    expect(out[2]).toBe(messages[2]);
  });
  it("returns null ledger when nothing happened", () => {
    expect(ledgerFor([{ type: "text", text: "hi" } as never])).toBeNull();
  });
});

describe("persisted message parts", () => {
  it("pairs tool calls with results in step order", () => {
    const parts = stepsToParts([
      {
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "Writing" },
          { type: "tool-call", toolCallId: "c1", toolName: "write_file", input: { path: "a" } },
          { type: "tool-result", toolCallId: "c1", toolName: "write_file", input: { path: "a" }, output: { ok: true, text: "ok" } },
        ],
      },
      { content: [{ type: "tool-call", toolCallId: "c2", toolName: "verify", input: {} }, { type: "tool-error", toolCallId: "c2", toolName: "verify", input: {}, error: new Error("boom") }] },
    ]);
    expect(parts.map((p) => p.type)).toEqual(["step-start", "reasoning", "text", "tool-write_file", "step-start", "tool-verify"]);
    expect(parts[3]).toMatchObject({ state: "output-available", output: { ok: true } });
    expect(parts[5]).toMatchObject({ state: "output-error", errorText: "boom" });
  });
});

describe("mock model scripting", () => {
  it("advances a scenario per assistant turn and survives harness-injected messages", () => {
    const first = pickTurn([{ role: "user", content: "[mock:broken] go" }], ["write_file"]);
    expect(first.toolCalls?.[0]?.name).toBe("write_file");
    const third = pickTurn(
      [
        { role: "user", content: "[mock:broken] go" },
        { role: "assistant", content: "" },
        { role: "assistant", content: "All done." },
        { role: "user", content: "[Automatic check] fix it" },
      ],
      ["write_file"],
    );
    expect(third.text).toMatch(/Fixing/);
  });
});

describe("version titles", () => {
  it("turns the agent's reply into a short title", () => {
    expect(versionTitle("I've built a habit tracker with the following features:\n- **Add habits**")).toBe("Built a habit tracker");
    expect(versionTitle("Fixed: the page compiles and the preview works.")).toBe("Fixed: the page compiles and the preview works");
    expect(versionTitle("Your greeting page is live in the preview, with a counter button.")).toBe("Your greeting page is live in the preview, with a counter button");
    expect(versionTitle("## Done! I have added dark mode to the settings page.")).toBe("Added dark mode to the settings page");
    expect(versionTitle("I’ve built a simple habit tracker that lets you:\n- **Add a habit**")).toBe("Built a simple habit tracker");
    expect(versionTitle(undefined)).toBe("Update");
    expect(versionTitle("x".repeat(100)).length).toBeLessThanOrEqual(72);
  });
});

