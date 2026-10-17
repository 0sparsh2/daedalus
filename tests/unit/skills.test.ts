import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "@/lib/skills/builtin";
import { parseSkill, serializeSkill, skillIndex, validateSkill } from "@/lib/skills/skill-file";

describe("SKILL.md format", () => {
  it("round-trips through serialize and parse", () => {
    const skill = { name: "brand-voice", description: "Write the way Acme talks: warm, short. Use for customer-facing text.", body: "- Two paragraphs at most.\n- No jargon." };
    expect(parseSkill(serializeSkill(skill))).toEqual(skill);
  });

  it("reads quoted values, Windows line endings, and falls back to the folder name", () => {
    expect(parseSkill('---\r\nname: "charts"\r\ndescription: \'Bar and line charts\'\r\n---\r\nUse Recharts.')).toEqual({ name: "charts", description: "Bar and line charts", body: "Use Recharts." });
    expect(parseSkill("---\ndescription: Tag emails by urgency\n---\nSteps", "email-triage")?.name).toBe("email-triage");
    expect(parseSkill("no frontmatter here")).toBeNull();
    expect(parseSkill("---\nname: x\n---\nmissing description")).toBeNull();
  });

  it("validates names and descriptions like the open format expects", () => {
    expect(validateSkill({ name: "brand-voice", description: "ok" })).toBeNull();
    expect(validateSkill({ name: "Brand Voice", description: "ok" })).toMatch(/lowercase/);
    expect(validateSkill({ name: "a".repeat(65), description: "ok" })).toMatch(/lowercase/);
    expect(validateSkill({ name: "x", description: " " })).toMatch(/description/);
  });

  it("lists only names and descriptions in the prompt", () => {
    const index = skillIndex([{ name: "charts", description: "Add charts", source: "builtin" }]);
    expect(index).toContain("- charts: Add charts");
    expect(index).toContain("skill tool");
    expect(skillIndex([])).toBe("");
  });

  it("ships valid built-in skills", () => {
    for (const s of BUILTIN_SKILLS) {
      expect(validateSkill(s), s.name).toBeNull();
      expect(parseSkill(serializeSkill(s))).toEqual(s);
    }
  });
});
