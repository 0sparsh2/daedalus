import { deployConfigured } from "@/lib/deploy";
import { getConnection, githubConfigured } from "@/lib/github";
import { withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** What the Ship menu can do for this project right now. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const conn = githubConfigured() ? await getConnection(user.id).catch(() => null) : null;
    const { data: dep } = await supabaseAdmin().from("deployments").select("url,status").eq("project_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    return Response.json({
      github: { configured: githubConfigured(), connected: Boolean(conn), login: conn?.login, repo: project.github_repo },
      deploy: { configured: deployConfigured(), url: project.deploy_url, status: dep?.status ?? null },
    });
  });
}
