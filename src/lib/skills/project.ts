import "server-only";
import { shellQuote, type SandboxHandle } from "@/lib/sandbox";
import { BUILTIN_SKILLS, builtinSkill } from "./builtin";
import { SKILL_DIRS, parseSkill, serializeSkill, type Skill, type SkillSummary } from "./skill-file";

/**
 * Project skills are ordinary files in the user's repo (`.agents/skills/<name>/SKILL.md`), so
 * they're versioned with the app and readable by other agent tools. Built-in skills ship with
 * Daedalus; a project can switch any of them off (`projects.settings.disabledSkills`).
 */

const SEP = "@@SKILL@@";

/** Every project skill's name and description, read in one sandbox command. */
export async function listProjectSkills(sbx: SandboxHandle): Promise<SkillSummary[]> {
  const globs = SKILL_DIRS.map((d) => `${d}/*/SKILL.md`).join(" ");
  const r = await sbx.exec(`for f in ${globs}; do [ -f "$f" ] && { echo "${SEP} $f"; head -c 4000 "$f"; echo; }; done; true`, { timeoutMs: 20_000 });
  const out: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const chunk of r.stdout.split(`${SEP} `).slice(1)) {
    const nl = chunk.indexOf("\n");
    const path = chunk.slice(0, nl).trim();
    const dirName = path.split("/").at(-2);
    const skill = parseSkill(chunk.slice(nl + 1), dirName);
    if (!skill || seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push({ name: skill.name, description: skill.description, source: "project", path });
  }
  return out;
}

/** The skills an agent sees in this project: project skills first, then built-ins that are switched on. */
export async function skillsForRun(sbx: SandboxHandle, disabled: string[] = []): Promise<SkillSummary[]> {
  const project = await listProjectSkills(sbx).catch(() => []);
  const names = new Set(project.map((s) => s.name));
  const builtins = BUILTIN_SKILLS.filter((s) => !disabled.includes(s.name) && !names.has(s.name)).map(
    (s): SkillSummary => ({ name: s.name, description: s.description, source: "builtin" }),
  );
  return [...project, ...builtins];
}

/** Loads one skill's full instructions, plus the other files in its folder (scripts, references). */
export async function loadSkill(sbx: SandboxHandle, name: string, disabled: string[] = []): Promise<{ skill: Skill; files: string[]; source: SkillSummary["source"] } | null> {
  for (const dir of SKILL_DIRS) {
    const bytes = await sbx.readFile(`${dir}/${name}/SKILL.md`);
    if (!bytes) continue;
    const skill = parseSkill(new TextDecoder().decode(bytes), name);
    if (!skill) continue;
    const ls = await sbx.exec(`find ${shellQuote(`${dir}/${name}`)} -maxdepth 3 -type f ! -name SKILL.md 2>/dev/null | head -50`, { timeoutMs: 15_000 });
    return { skill, files: ls.stdout.split("\n").map((l) => l.trim()).filter(Boolean), source: "project" };
  }
  const builtin = builtinSkill(name);
  if (builtin && !disabled.includes(name)) return { skill: builtin, files: [], source: "builtin" };
  return null;
}

/** Writes a project skill into the repo and saves it as a version. */
export async function saveProjectSkill(sbx: SandboxHandle, skill: Skill) {
  const path = `${SKILL_DIRS[0]}/${skill.name}/SKILL.md`;
  await sbx.writeFiles([{ path, content: serializeSkill(skill) }]);
  await sbx.exec(`git add ${shellQuote(path)} && (git diff --cached --quiet || git commit -q -m ${shellQuote(`Skill: ${skill.name}`)})`, { timeoutMs: 30_000 });
  return path;
}

export async function deleteProjectSkill(sbx: SandboxHandle, name: string) {
  const dirs = SKILL_DIRS.map((d) => shellQuote(`${d}/${name}`)).join(" ");
  await sbx.exec(`rm -rf ${dirs} && git add -A ${SKILL_DIRS.join(" ")} 2>/dev/null; (git diff --cached --quiet || git commit -q -m ${shellQuote(`Remove skill: ${name}`)}); true`, { timeoutMs: 30_000 });
}
