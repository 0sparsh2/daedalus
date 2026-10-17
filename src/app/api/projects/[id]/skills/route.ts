import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { activeRun, getProject } from "@/lib/projects";
import { attachProjectSandbox } from "@/lib/sandbox";
import { BUILTIN_SKILLS } from "@/lib/skills/builtin";
import { deleteProjectSkill, listProjectSkills, loadSkill, saveProjectSkill } from "@/lib/skills/project";
import { serializeSkill, validateSkill } from "@/lib/skills/skill-file";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };
const settingsOf = (p: unknown) => ((p as { settings?: Record<string, unknown> }).settings ?? {}) as { disabledSkills?: string[] } & Record<string, unknown>;

/** Skills for a project: built-ins (with on/off) and the project's own SKILL.md files. `?name=` returns one in full. */
export async function GET(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const disabled = settingsOf(project).disabledSkills ?? [];
    const name = new URL(req.url).searchParams.get("name");
    if (name) {
      const sbx = project.sandbox_id ? await attachProjectSandbox(id) : null;
      const found = sbx ? await loadSkill(sbx, name, []) : null;
      const builtin = BUILTIN_SKILLS.find((s) => s.name === name);
      const skill = found?.skill ?? builtin;
      if (!skill) return jsonError(404, "No such skill", "not_found");
      return Response.json({ ...skill, source: found?.source ?? "builtin", content: serializeSkill(skill), files: found?.files ?? [] });
    }
    const project_skills = project.sandbox_id ? await listProjectSkills(await attachProjectSandbox(id)).catch(() => []) : [];
    return Response.json({
      builtin: BUILTIN_SKILLS.map((s) => ({ name: s.name, description: s.description, enabled: !disabled.includes(s.name), overridden: project_skills.some((p) => p.name === s.name) })),
      project: project_skills,
      hasSandbox: Boolean(project.sandbox_id),
    });
  });
}

const saveSchema = z.object({ name: z.string().min(1).max(64), description: z.string().min(1).max(1024), body: z.string().max(50_000) });

/** Creates or replaces a project skill; it's committed to the repo as a version. */
export async function POST(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    if (!project.sandbox_id) return jsonError(409, "Start the project first.", "no_sandbox");
    if (await activeRun(id)) return jsonError(409, "Wait for the current run to finish.", "run_in_progress");
    const parsed = saveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "A skill needs a name, a description and instructions.", "bad_request");
    const problem = validateSkill(parsed.data);
    if (problem) return jsonError(400, problem, "bad_request");
    const path = await saveProjectSkill(await attachProjectSandbox(id), parsed.data);
    return Response.json({ ok: true, path });
  });
}

const toggleSchema = z.object({ name: z.string().min(1).max(64), enabled: z.boolean() });

/** Switches a built-in skill on or off for this project. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const parsed = toggleSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success || !BUILTIN_SKILLS.some((s) => s.name === parsed.data.name)) return jsonError(400, "Unknown built-in skill", "bad_request");
    const settings = settingsOf(project);
    const disabled = new Set(settings.disabledSkills ?? []);
    if (parsed.data.enabled) disabled.delete(parsed.data.name);
    else disabled.add(parsed.data.name);
    const next = { ...settings, disabledSkills: [...disabled] };
    await supabaseAdmin().from("projects").update({ settings: next }).eq("id", id).eq("user_id", user.id);
    return Response.json({ ok: true, disabledSkills: next.disabledSkills });
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const name = new URL(req.url).searchParams.get("name") ?? "";
    if (validateSkill({ name, description: "x" })) return jsonError(400, "Invalid skill name", "bad_request");
    if (!project.sandbox_id) return jsonError(409, "Start the project first.", "no_sandbox");
    if (await activeRun(id)) return jsonError(409, "Wait for the current run to finish.", "run_in_progress");
    await deleteProjectSkill(await attachProjectSandbox(id), name);
    return Response.json({ ok: true });
  });
}
