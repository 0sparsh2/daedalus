import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { activeRun, getProject } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { applySuggestion, listSuggestions, type SuggestionRow } from "@/lib/suggestions-store";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** The project's suggested skills and rules (pending, kept and dismissed). */
export async function GET(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    return Response.json({ suggestions: await listSuggestions(id) });
  });
}

const decideSchema = z.object({ id: z.string().uuid(), status: z.enum(["kept", "dismissed"]) });

/** Keep (apply) or discard a suggestion. Keeping a skill writes it to the repo, so it waits for a running build to finish. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const parsed = decideSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid request", "bad_request");
    const db = supabaseAdmin();
    const { data: row } = await db.from("suggestions").select("id,kind,name,payload,evidence,status,run_id,created_at").eq("id", parsed.data.id).eq("project_id", id).eq("user_id", user.id).maybeSingle();
    if (!row) return jsonError(404, "Suggestion not found", "not_found");
    if (row.status !== "proposed") return Response.json({ ok: true, status: row.status });

    let note = "";
    if (parsed.data.status === "kept") {
      if (row.kind === "skill") {
        if (!project.sandbox_id) return jsonError(409, "Start the project first.", "no_sandbox");
        if (await activeRun(id)) return jsonError(409, "Keep it once the current run has finished.", "run_in_progress");
      }
      try {
        note = await applySuggestion(user.id, id, row as SuggestionRow);
      } catch (err) {
        return jsonError(500, `Couldn't apply it: ${err instanceof Error ? err.message : String(err)}`, "apply_failed");
      }
    }
    await db.from("suggestions").update({ status: parsed.data.status, decided_at: new Date().toISOString() }).eq("id", row.id);
    return Response.json({ ok: true, status: parsed.data.status, note });
  });
}
