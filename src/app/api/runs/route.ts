import { jsonError, withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Runs for a project, newest first (Trace view's run picker). */
export async function GET(req: Request) {
  return withUser(async (user) => {
    const projectId = new URL(req.url).searchParams.get("projectId");
    if (!projectId) return jsonError(400, "projectId is required", "bad_request");
    await getProject(user.id, projectId);
    const { data } = await supabaseAdmin()
      .from("runs")
      .select("id,mode,provider,model,status,started_at,ended_at,input_tokens,output_tokens,llm_calls,tool_calls,summary,error")
      .eq("project_id", projectId)
      .order("started_at", { ascending: false })
      .limit(50);
    return Response.json({ runs: data ?? [] });
  });
}
