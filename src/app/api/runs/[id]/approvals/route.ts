import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { toolApprovalHook } from "@/workflows/hooks";

const bodySchema = z.object({ toolCallId: z.string().min(1).max(200), decision: z.enum(["approved", "always", "denied"]) });

/**
 * The user's answer to a connection tool waiting for approval. Only the run's owner can answer,
 * and only while the call is still waiting; the run then carries on from where it paused.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid request", "bad_request");
    const { data: row } = await supabaseAdmin().from("approvals").select("token,status,user_id").eq("run_id", id).eq("tool_call_id", parsed.data.toolCallId).maybeSingle();
    if (!row || row.user_id !== user.id) return jsonError(404, "No approval like that", "not_found");
    if (row.status !== "waiting") return jsonError(409, `Already ${row.status}`, "already_decided");
    try {
      await toolApprovalHook.resume(row.token, { decision: parsed.data.decision });
    } catch {
      return jsonError(409, "This request is no longer waiting.", "not_waiting");
    }
    return Response.json({ ok: true });
  });
}
