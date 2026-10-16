import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";

const schema = z.object({
  kind: z.string().max(40).default("error"),
  message: z.string().min(1).max(4000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(2000).optional(),
  checkId: z.string().max(200).optional(),
});

/**
 * Runtime errors forwarded by the workspace from the preview bridge; the agent's check_preview
 * reads them. `kind: "load"` rows are markers for a check's fresh load ("ack", then "loaded").
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid error report", "bad_request");
    const { checkId, ...report } = parsed.data;
    await supabaseAdmin().from("preview_errors").insert({ project_id: id, user_id: user.id, ...report, check_id: checkId ?? null });
    return Response.json({ ok: true });
  });
}
