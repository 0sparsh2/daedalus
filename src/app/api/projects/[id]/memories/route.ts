import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { memoriesFor } from "@/lib/memory/memory";
import { getProject } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";

type Ctx = { params: Promise<{ id: string }> };

/** Memories for this project and the user's cross-project ones (proposed and kept). */
export async function GET(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    return Response.json({ memories: await memoriesFor(user.id, id) });
  });
}

const addSchema = z.object({ text: z.string().min(3).max(500), scope: z.enum(["project", "me"]).default("project") });

/** A memory the user adds themselves: kept straight away. */
export async function POST(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const parsed = addSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "A memory is one sentence, 3 to 500 characters.", "bad_request");
    const { data, error } = await supabaseAdmin()
      .from("memories")
      .insert({ user_id: user.id, project_id: parsed.data.scope === "me" ? null : id, text: parsed.data.text.trim(), source: "user", status: "kept", decided_at: new Date().toISOString() })
      .select("id")
      .single();
    if (error) return jsonError(500, error.message, "db_error");
    return Response.json({ ok: true, id: data.id });
  });
}

const decideSchema = z.object({ id: z.string().uuid(), status: z.enum(["kept", "dismissed"]) });

/** Keep or discard a proposed memory (or stop using a kept one). */
export async function PATCH(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const parsed = decideSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid request", "bad_request");
    await supabaseAdmin().from("memories").update({ status: parsed.data.status, decided_at: new Date().toISOString() }).eq("id", parsed.data.id).eq("user_id", user.id);
    return Response.json({ ok: true });
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const memId = new URL(req.url).searchParams.get("id") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(memId)) return jsonError(400, "Invalid id", "bad_request");
    await supabaseAdmin().from("memories").delete().eq("id", memId).eq("user_id", user.id);
    return Response.json({ ok: true });
  });
}
