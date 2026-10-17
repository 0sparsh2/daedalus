import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { turnFacts } from "@/lib/agent/history";
import { FINAL_STEP_NOTE, makePrepareStep } from "@/lib/agent/loop";
import { fitToMode, isSmallTalk, parseRoute, routerInput, ruleRoute } from "@/lib/agent/router";
import { normalizeQuestions } from "@/lib/plan";

describe("turn router: rules", () => {
  it("recognises small talk, and nothing more", () => {
    for (const t of ["Hi", "hi!", "Hello there", "hey", "thanks!", "Thank you so much", "ok", "👍", "Good morning", "sounds good"]) expect(isSmallTalk(t), t).toBe(true);
    for (const t of ["Hi, build me a todo app", "hey can you make it blue", "thanks, now add dark mode", "ok do it", "What can you build?"]) expect(isSmallTalk(t), t).toBe(false);
  });

  it("decides actions, scripted tests and greetings without a model call", () => {
    expect(ruleRoute({ text: "Hi", mode: "plan" })).toMatchObject({ route: "chat", by: "rule" });
    expect(ruleRoute({ text: "Looks good. Build it.", mode: "build", intent: "build" })).toMatchObject({ route: "build", by: "action" });
    expect(ruleRoute({ text: "A booking app", mode: "plan", intent: "answer" })).toMatchObject({ route: "plan", by: "action" });
    expect(ruleRoute({ text: "[mock:hello] Smoke test", mode: "build" })).toMatchObject({ route: "build", by: "rule" });
    expect(ruleRoute({ text: "How does the streak work?", mode: "build" })).toBeNull();
  });

  it("keeps routes inside the user's mode: Plan never builds", () => {
    expect(fitToMode("build", "plan")).toBe("plan");
    expect(fitToMode("plan", "build")).toBe("build");
    expect(fitToMode("ask", "plan")).toBe("ask");
    expect(fitToMode("chat", "build")).toBe("chat");
    expect(ruleRoute({ text: "x", mode: "plan", intent: "build" })?.route).toBe("plan");
  });
});

describe("turn router: the classifier's answer", () => {
  it("reads JSON, JSON after reasoning, or a bare route word", () => {
    expect(parseRoute('{"route": "ask", "reason": "question about the code"}')).toEqual({ route: "ask", reason: "question about the code" });
    expect(parseRoute('Thinking about it... {"route":"BUILD","reason":"asks to add dark mode"}')?.route).toBe("build");
    expect(parseRoute("This is a chat message.")?.route).toBe("chat");
    expect(parseRoute("no idea")).toBeNull();
  });

  it("tells the classifier what's allowed and where the project stands", () => {
    const text = routerInput({ text: "make it blue", mode: "plan", hasWork: true, pendingPlan: true, lastAssistant: "Here's the plan." });
    expect(text).toContain('"chat", "ask", "plan"');
    expect(text).toContain("has a built app");
    expect(text).toContain("a proposed plan is waiting");
  });
});

describe("conversation facts for routing", () => {
  const msg = (id: string, role: "user" | "assistant", parts: unknown[]): UIMessage => ({ id, role, parts: parts as UIMessage["parts"] });
  it("finds the new message, the reply before it, a pending plan, and open questions", () => {
    const facts = turnFacts([
      msg("u1", "user", [{ type: "text", text: "An app for my bakery" }]),
      msg("a1", "assistant", [
        { type: "text", text: "A couple of questions first." },
        { type: "tool-ask_user", toolCallId: "q", state: "output-available", input: { questions: [{ question: "Online orders or just a menu?" }] } },
      ]),
      msg("u2", "user", [{ type: "text", text: "Online orders" }]),
    ]);
    expect(facts.text).toBe("Online orders");
    expect(facts.lastAssistant).toContain("Online orders or just a menu?");
    expect(facts.pendingPlan).toBe(false);
  });
});

describe("question cards", () => {
  it("normalizes whatever shape the model sent", () => {
    expect(normalizeQuestions({ questions: [{ question: "Who is it for?", options: ["Me", "My team (Recommended)"] }] })).toEqual([{ question: "Who is it for?", options: ["Me", "My team (Recommended)"] }]);
    expect(normalizeQuestions({ questions: ["What colour?", { text: "How many users?" }] }).map((q) => q.question)).toEqual(["What colour?", "How many users?"]);
    expect(normalizeQuestions({ questions: "- One?\n- Two?" })).toHaveLength(2);
    expect(normalizeQuestions(null)).toEqual([]);
  });
});

describe("step budget", () => {
  it("switches tools off on the last step and asks for a summary", () => {
    const prep = makePrepareStep({ contextWindow: 128_000, route: "ask" });
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "How does it work?" }] }];
    expect(prep({ stepNumber: 3, steps: [], messages })).toEqual({});
    const last = prep({ stepNumber: 19, steps: [], messages }) as { activeTools?: unknown[]; messages?: Array<{ content: Array<{ text?: string }> }> };
    expect(last.activeTools).toEqual([]);
    expect(JSON.stringify(last.messages)).toContain(FINAL_STEP_NOTE.slice(0, 40));
  });
});
