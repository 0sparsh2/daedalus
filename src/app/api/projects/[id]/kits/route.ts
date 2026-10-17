import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { KITS, kitById } from "@/lib/kits";
import { addConnection, listConnections } from "@/lib/mcp/connections";
import { activeRun, getProject } from "@/lib/projects";
import { rulesSchema, type Rule } from "@/lib/rules";
import { attachProjectSandbox } from "@/lib/sandbox";
import { saveProjectSkill } from "@/lib/skills/project";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };
type Settings = { rules?: unknown; kits?: string[] } & Record<string, unknown>;
const settingsOf = (p: unknown) => ((p as { settings?: Settings }).settings ?? {}) as Settings;

export async function GET(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const installed = settingsOf(project).kits ?? [];
    return Response.json({
      kits: KITS.map((k) => ({
        id: k.id,
        name: k.name,
        description: k.description,
        contents: [k.connections.length && `${k.connections.length} connection${k.connections.length === 1 ? "" : "s"}`, k.skills.length && `${k.skills.length} skill${k.skills.length === 1 ? "" : "s"}`, k.rules.length && `${k.rules.length} rule${k.rules.length === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
        installed: installed.includes(k.id),
      })),
    });
  });
}

/** Installs a kit: its skills into the repo, its rules into the project, its connections. Parts that exist are kept. */
export async function POST(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const parsed = z.object({ id: z.string() }).safeParse(await req.json().catch(() => null));
    const kit = parsed.success ? kitById(parsed.data.id) : undefined;
    if (!kit) return jsonError(400, "Unknown kit", "bad_request");
    if (kit.skills.length && !project.sandbox_id) return jsonError(409, "Start the project first.", "no_sandbox");
    if (await activeRun(id)) return jsonError(409, "Wait for the current run to finish.", "run_in_progress");

    const done: string[] = [];
    if (kit.skills.length) {
      const sbx = await attachProjectSandbox(id);
      for (const s of kit.skills) await saveProjectSkill(sbx, s);
      done.push(`${kit.skills.length} skill${kit.skills.length === 1 ? "" : "s"}`);
    }
    const existing = await listConnections(id);
    for (const c of kit.connections) {
      if (existing.some((e) => e.name === c.name || e.url === c.url)) continue;
      await addConnection({ userId: user.id, projectId: id, name: c.name, url: c.url, readOnly: c.readOnly }).catch(() => {});
      done.push(`connected ${c.name}`);
    }
    const settings = settingsOf(project);
    const current = rulesSchema.safeParse(settings.rules ?? []);
    const rules: Rule[] = current.success ? current.data : [];
    for (const r of kit.rules) {
      if (rules.some((x) => x.label === r.label)) continue;
      rules.push({ ...r, id: Math.random().toString(36).slice(2, 10), enabled: true } as Rule);
    }
    if (kit.rules.length) done.push(`${kit.rules.length} rule${kit.rules.length === 1 ? "" : "s"}`);
    const kits = [...new Set([...(settings.kits ?? []), kit.id])];
    await supabaseAdmin().from("projects").update({ settings: { ...settings, rules, kits } }).eq("id", id).eq("user_id", user.id);
    return Response.json({ ok: true, installed: done });
  });
}
