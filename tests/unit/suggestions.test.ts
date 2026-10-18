import { describe, expect, it } from "vitest";
import { CONTENT_IS_DATA, EXPLORE_PROMPT, RESEARCH_PROMPT, SUBAGENT_CONTENT_IS_DATA, askPrompt, buildPrompt, chatPrompt, planPrompt, reviewPrompt } from "@/lib/agent/prompts";
import { ruleRoute } from "@/lib/agent/router";
import { describeSuggestedRule, normalizeSuggestion } from "@/lib/suggestions";

const evidence = "The streak reset twice after a reload in run 3.";

describe("suggestions", () => {
  it("accepts a skill with real instructions", () => {
    const s = normalizeSuggestion({ kind: "skill", name: "Date-Handling", description: "How dates work here. Use when touching dates.", instructions: "- Store ISO strings.\n- Compare as strings, never Date objects.", evidence });
    expect(s).toMatchObject({ kind: "skill", name: "date-handling", payload: { name: "date-handling" }, evidence });
  });
  it("refuses a skill without instructions or with a bad name", () => {
    expect(normalizeSuggestion({ kind: "skill", name: "dates", description: "Dates.", instructions: "Be careful.", evidence })).toHaveProperty("error");
    expect(normalizeSuggestion({ kind: "skill", name: "date handling!", description: "Dates.", instructions: "x".repeat(60), evidence })).toHaveProperty("error");
  });
  it("shapes each kind of rule, and says what's missing", () => {
    const finish = normalizeSuggestion({ kind: "rule", name: "Type check", description: "Type errors slipped through.", event: "before_finish", command: "npx tsc --noEmit", evidence });
    expect(finish).toEqual({ kind: "rule", name: "Type check", payload: { event: "before_finish", label: "Type check", command: "npx tsc --noEmit" }, evidence });
    const block = normalizeSuggestion({ kind: "rule", name: "No installs", description: "Ask first.", event: "before_command", pattern: "npm install", evidence });
    expect(block).toMatchObject({ payload: { event: "before_command", pattern: "npm install", reason: "Ask first." } });
    const fmt = normalizeSuggestion({ kind: "rule", name: "Format", description: "Keep style.", event: "after_change", command: "npx prettier --write {file}", evidence });
    expect(fmt).toMatchObject({ payload: { glob: "**/*" } });
    expect(normalizeSuggestion({ kind: "rule", name: "Format", description: "x", event: "after_change", evidence })).toEqual({ error: "This rule needs a command." });
    expect(normalizeSuggestion({ kind: "rule", name: "Block", description: "x", event: "before_command", evidence })).toEqual({ error: "This rule needs a pattern." });
    expect(normalizeSuggestion({ kind: "rule", name: "No event", description: "x", command: "ls", evidence })).toHaveProperty("error");
    if ("payload" in finish && finish.kind === "rule") expect(describeSuggestedRule(finish.payload)).toBe("Before finishing a change, run npx tsc --noEmit");
  });
});

describe("review route and prompt boundaries", () => {
  it("routes a review request without the classifier", () => {
    expect(ruleRoute({ text: "Review my runs", mode: "plan", intent: "review" })).toMatchObject({ route: "review", by: "action" });
  });
  const ctx = { projectName: "Habits", fileTree: "src/App.tsx", today: "2026-10-18", runsIndex: "- 1234 · run" };
  it("puts the content-is-data boundary in every prompt that reads outside material", () => {
    for (const p of [buildPrompt(ctx), planPrompt(ctx), askPrompt(ctx), reviewPrompt(ctx)]) expect(p).toContain(CONTENT_IS_DATA);
    for (const p of [RESEARCH_PROMPT, EXPLORE_PROMPT]) expect(p).toContain(SUBAGENT_CONTENT_IS_DATA);
  });
  it("teaches the cheapest form for what the agent learns, except in chat", () => {
    expect(buildPrompt(ctx)).toContain("# Keeping what you learn");
    expect(chatPrompt({ projectName: "Habits", state: "new", today: "2026-10-18" })).not.toContain("Keeping what you learn");
    expect(reviewPrompt(ctx)).toContain("- 1234 · run");
  });
});
