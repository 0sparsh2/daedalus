import { describe, expect, it } from "vitest";
import { activeToken, insertToken, parseMentions, rankFiles, splitMentions } from "@/lib/mentions";

describe("mentions in a message", () => {
  it("finds files, skills and commands", () => {
    expect(parseMentions("/build make @src/App.tsx use /charts and /brand-voice, see @package.json.")).toEqual({
      files: ["src/App.tsx", "package.json"],
      skills: ["charts", "brand-voice"],
      commands: ["build"],
    });
  });
  it("ignores emails, handles, URLs and escapes", () => {
    expect(parseMentions("mail me@x.com or ping @alice, see https://a.com/b and @../secret.txt").files).toEqual([]);
    expect(parseMentions("go to /api/users or 3/4").skills).toEqual([]);
  });
  it("knows the token at the caret", () => {
    expect(activeToken("look at @src/Ap", 15)).toEqual({ kind: "file", query: "src/Ap", start: 8 });
    expect(activeToken("/cha", 4)).toEqual({ kind: "slash", query: "cha", start: 0 });
    expect(activeToken("plain words", 11)).toBeNull();
    expect(activeToken("a /api/x", 8)).toBeNull();
  });
  it("inserts a mention in place of what was typed", () => {
    expect(insertToken("look at @src/Ap please", 8, 15, "@src/App.tsx")).toEqual({ text: "look at @src/App.tsx please", caret: 21 });
    expect(insertToken("/cha", 0, 4, "/charts")).toEqual({ text: "/charts ", caret: 8 });
  });
  it("ranks file suggestions by name first", () => {
    const files = ["src/App.tsx", "src/components/AppHeader.tsx", "index.html", "src/lib/app-store.ts"];
    expect(rankFiles(files, "app")[0]).toBe("src/App.tsx");
    expect(rankFiles(files, "")).toEqual(["src/App.tsx", "src/components/AppHeader.tsx", "src/lib/app-store.ts"]);
  });
  it("splits a message into text and mentions for display", () => {
    expect(splitMentions("Use /charts on @src/App.tsx, not /etc/hosts")).toEqual([
      { text: "Use " },
      { text: "/charts", kind: "skill" },
      { text: " on " },
      { text: "@src/App.tsx", kind: "file" },
      { text: ", not /etc/hosts" },
    ]);
    expect(splitMentions("/plan a todo app")).toEqual([{ text: "/plan a todo app" }]);
  });
});
