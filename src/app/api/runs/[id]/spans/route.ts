import { jsonError, withUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** The run's trace: every span (run, sandbox, llm, tool, sub-agent, verify) for the Trace view. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const db = supabaseAdmin();
    const { data: run } = await db.from("runs").select("*").eq("id", id).maybeSingle();
    if (!run || run.user_id !== user.id) return jsonError(404, "Run not found", "not_found");
    const { data: spans } = await db.from("spans").select("*").eq("run_id", id).order("started_at", { ascending: true }).limit(2000);
    return Response.json({ run, spans: spans ?? [] });
  });
}
