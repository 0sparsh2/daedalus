import { jsonError, withUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Stops a run. The run is marked cancelled; the LLM gateway refuses its next model call, so
 * the agent loop ends cleanly at the next step and the finish step still saves a checkpoint.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const db = supabaseAdmin();
    const { data: run } = await db.from("runs").select("id,user_id,status").eq("id", id).maybeSingle();
    if (!run || run.user_id !== user.id) return jsonError(404, "Run not found", "not_found");
    if (run.status === "queued" || run.status === "running") {
      await db.from("runs").update({ status: "cancelled" }).eq("id", id);
    }
    return Response.json({ ok: true });
  });
}
