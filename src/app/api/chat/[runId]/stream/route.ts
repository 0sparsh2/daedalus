import { createUIMessageStreamResponse } from "ai";
import { getRun } from "workflow/api";
import { createUITransform } from "@/lib/agent/ui-transform";
import { jsonError, withUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 300;

/** Reconnects to a run's durable stream (page reload, network drop, function timeout). */
export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  return withUser(async (user) => {
    const { runId: workflowRunId } = await ctx.params;
    const startIndex = Number(new URL(req.url).searchParams.get("startIndex") ?? "0");
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) return jsonError(400, "startIndex must be a non-negative integer", "bad_request");
    const { data: run } = await supabaseAdmin().from("runs").select("id,project_id,user_id").eq("workflow_run_id", workflowRunId).maybeSingle();
    if (!run || run.user_id !== user.id) return jsonError(404, "Run not found", "not_found");
    const readable = getRun(workflowRunId)
      .getReadable({ startIndex: 0 })
      .pipeThrough(createUITransform({ uiStartIndex: startIndex, messageId: `a-${run.id}`, metadata: { runId: run.id, projectId: run.project_id } }));
    return createUIMessageStreamResponse({ stream: readable, headers: { "x-workflow-run-id": workflowRunId, "x-daedalus-run-id": run.id } });
  });
}
