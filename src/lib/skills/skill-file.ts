/**
 * Skills use the open SKILL.md format: YAML frontmatter with a `name` and a `description`,
 * then Markdown instructions. Only the name and description go into the agent's prompt; the
 * `skill` tool loads the rest when a task matches (progressive disclosure), so twenty skills
 * cost a few hundred tokens until one is used. Pure functions: shared by server and tests.
 */

export interface Skill {
  name: string;
  description: string;
  body: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: "builtin" | "project";
  /** For project skills: the SKILL.md path in the repo. */
  path?: string;
}

/** Where project skills live in the repo. `.agents/` is read and written; `.claude/` is read for imported repos. */
export const SKILL_DIRS = [".agents/skills", ".claude/skills"] as const;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSkill(s: { name: string; description: string; body?: string }): string | null {
  if (!NAME.test(s.name) || s.name.length > 64) return "Use a short name in lowercase words joined by hyphens, like brand-voice.";
  if (!s.description.trim()) return "Add a description: what the skill does and when to use it.";
  if (s.description.length > 1024) return "Keep the description under 1,024 characters.";
  if (s.body !== undefined && s.body.length > 50_000) return "Keep the instructions under 50,000 characters.";
  return null;
}

/** Parses SKILL.md. Accepts single-line `key: value` frontmatter (quoted or not). */
export function parseSkill(text: string, fallbackName?: string): Skill | null {
  const m = text.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const name = (meta.name || fallbackName || "").trim();
  const description = (meta.description || "").trim();
  if (!name || !description) return null;
  return { name, description, body: m[2].trim() };
}

export function serializeSkill(s: Skill): string {
  const quote = (v: string) => (/[:#"'\n]|^\s|\s$/.test(v) ? JSON.stringify(v) : v);
  return `---\nname: ${s.name}\ndescription: ${quote(s.description.replace(/\s+/g, " ").trim())}\n---\n\n${s.body.trim()}\n`;
}

/** The skills section of the agent's prompt: names and descriptions only. */
export function skillIndex(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return `# Skills
Skills are playbooks for specific kinds of work. When a task matches a skill's description, load it with the skill tool first and follow it.
${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}
`;
}
