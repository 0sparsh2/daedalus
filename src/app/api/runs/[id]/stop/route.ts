import { jsonError, withUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { toolApprovalHook } from "@/workflows/hooks";

/**
 * Stops a run. The run is marked cancelled; the LLM gateway refuses its next model call, so
 * the agent loop ends cleanly at the next step and the finish step still saves a checkpoint. A
 * connection call waiting for approval is answered "stopped" so the run doesn't sit waiting.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const db = supabaseAdmin();
    const { data: run } = await db.from("runs").select("id,user_id,status").eq("id", id).maybeSingle();
    if (!run || run.user_id !== user.id) return jsonError(404, "Run not found", "not_found");
    if (run.status === "queued" || run.status === "running") {
      await db.from("runs").update({ status: "cancelled" }).eq("id", id);
      // A run paused on an approval would otherwise wait for its timeout: answer it for the user.
      const { data: waiting } = await db.from("approvals").select("token").eq("run_id", id).eq("status", "waiting");
      await Promise.all((waiting ?? []).map((w) => toolApprovalHook.resume(w.token, { decision: "stopped" }).catch(() => {})));
    }
    return Response.json({ ok: true });
  });
}
