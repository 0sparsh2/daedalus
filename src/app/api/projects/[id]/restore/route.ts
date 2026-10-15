import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { activeRun, getProject } from "@/lib/projects";
import { attachProjectSandbox, shellQuote } from "@/lib/sandbox";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 60;

const schema = z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/) });

/** Restores the app to a checkpoint as a new commit, so the restore itself can be undone. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    if (await activeRun(id)) return jsonError(409, "Wait for the current run to finish before restoring.", "run_in_progress");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid checkpoint", "bad_request");
    const { data: cp } = await supabaseAdmin().from("checkpoints").select("sha,message").eq("project_id", id).eq("sha", parsed.data.sha).maybeSingle();
    if (!cp) return jsonError(404, "Checkpoint not found", "not_found");
    const sbx = await attachProjectSandbox(id);
    const sha = shellQuote(cp.sha);
    const r = await sbx.exec(
      `git add -A && (git diff --cached --quiet || git commit -q -m "Save before restore") && git checkout ${sha} -- . && git ls-files -z | xargs -0 -I{} sh -c 'git cat-file -e ${cp.sha}:"{}" 2>/dev/null || rm -f "{}"' && git add -A && (git diff --cached --quiet && echo nochange || (git commit -q -m ${shellQuote(`Restore: ${cp.message}`.slice(0, 120))} && git rev-parse HEAD))`,
      { timeoutMs: 60_000 },
    );
    if (r.exitCode !== 0) return jsonError(500, `Restore failed: ${r.stderr.slice(0, 500)}`, "restore_failed");
    const out = r.stdout.trim().split("\n").pop() ?? "";
    if (out && out !== "nochange") {
      await supabaseAdmin().from("checkpoints").insert({ project_id: id, user_id: user.id, sha: out, message: `Restore: ${cp.message}`.slice(0, 120), files_changed: 0 });
    }
    return Response.json({ ok: true, sha: out === "nochange" ? cp.sha : out });
  });
}
