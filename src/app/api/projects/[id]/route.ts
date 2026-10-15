import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { activeRun, getProject, loadMessages } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";

type Ctx = { params: Promise<{ id: string }> };

/** Project, conversation, the in-flight run (to reconnect to) and checkpoints. */
export async function GET(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const [messages, running, checkpoints, deployments] = await Promise.all([
      loadMessages(id),
      activeRun(id),
      supabaseAdmin().from("checkpoints").select("id,sha,message,files_changed,created_at,run_id").eq("project_id", id).order("created_at", { ascending: false }).limit(30),
      supabaseAdmin().from("deployments").select("id,url,status,created_at,error").eq("project_id", id).order("created_at", { ascending: false }).limit(5),
    ]);
    return Response.json({ project, messages, activeRun: running, checkpoints: checkpoints.data ?? [], deployments: deployments.data ?? [] });
  });
}

const patchSchema = z.object({ name: z.string().trim().min(1).max(60) });

export async function PATCH(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Name must be 1-60 characters", "bad_request");
    await supabaseAdmin().from("projects").update({ name: parsed.data.name }).eq("id", id).eq("user_id", user.id);
    return Response.json({ ok: true });
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    await supabaseAdmin().from("projects").delete().eq("id", id).eq("user_id", user.id);
    return Response.json({ ok: true });
  });
}
