import { describe, expect, it } from "vitest";
import { describeRule, matchesCommand, matchesGlob, rulesFor, rulesSchema, withFile, type Rule } from "@/lib/rules";

describe("rules that always run", () => {
  it("blocks commands by prefix on word boundaries, or by wildcard", () => {
    expect(matchesCommand("npm install", "npm install zod")).toBe(true);
    expect(matchesCommand("npm install", "  NPM   install  ")).toBe(true);
    expect(matchesCommand("npm install", "npm installer")).toBe(false);
    expect(matchesCommand("npm install", "cd app && npm install left-pad")).toBe(true);
    expect(matchesCommand("npm install", "npm run build")).toBe(false);
    expect(matchesCommand("rm -rf *", "rm -rf node_modules")).toBe(true);
    expect(matchesCommand("rm -rf *", "ls -la")).toBe(false);
    expect(matchesCommand("", "anything")).toBe(false);
  });

  it("matches files by glob", () => {
    expect(matchesGlob("**/*", "src/App.tsx")).toBe(true);
    expect(matchesGlob("**/*", "index.html")).toBe(true);
    expect(matchesGlob("src/**/*.{ts,tsx}", "src/components/ui/button.tsx")).toBe(true);
    expect(matchesGlob("src/**/*.{ts,tsx}", "src/index.css")).toBe(false);
    expect(matchesGlob("src/*.css", "src/index.css")).toBe(true);
    expect(matchesGlob("src/*.css", "src/styles/x.css")).toBe(false);
  });

  it("puts the changed file into the command, quoted", () => {
    expect(withFile("npx prettier --write {file}", "src/App.tsx")).toBe("npx prettier --write 'src/App.tsx'");
    expect(withFile("npx eslint --fix", "src/it's.ts")).toBe("npx eslint --fix 'src/it'\\''s.ts'");
  });

  it("validates rules and picks the enabled ones for an event", () => {
    const rules = rulesSchema.parse([
      { id: "a", event: "before_finish", command: "npm test" },
      { id: "b", event: "before_command", pattern: "npm install", enabled: false },
      { id: "c", event: "after_change", command: "npx prettier --write {file}" },
    ]) as Rule[];
    expect(rulesFor(rules, "before_finish").map((r) => r.id)).toEqual(["a"]);
    expect(rulesFor(rules, "before_command")).toEqual([]);
    expect(rulesFor(rules, "after_change")[0].glob).toBe("**/*");
    expect(rulesSchema.safeParse([{ id: "x", event: "before_finish" }]).success).toBe(false);
    expect(describeRule(rules[0])).toBe("Before finishing a change, run npm test");
  });
});
