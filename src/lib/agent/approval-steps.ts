import "server-only";
import { redactValue } from "@/lib/redact";
import { setToolPolicies } from "@/lib/mcp/connections";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { endSpan, startSpan } from "@/lib/trace/spans";
import type { ApprovalDecision } from "@/workflows/hooks";
import { emit } from "./emit";
import { stableId } from "./runtime";
import type { RunScope } from "./scope";

export interface ApprovalRequest {
  toolCallId: string;
  token: string;
  connectionId: string;
  connection: string;
  tool: string;
  args: Record<string, unknown>;
}

const card = (r: ApprovalRequest, status: "waiting" | ApprovalDecision) => ({
  type: "data-approval" as const,
  id: `approval-${r.toolCallId}`,
  data: { toolCallId: r.toolCallId, connection: r.connection, tool: r.tool, args: redactValue(r.args), status },
});

/** Records the pending approval and shows the card. The run then waits on the hook. */
export async function requestApprovalStep(scope: RunScope, r: ApprovalRequest) {
  "use step";
  await supabaseAdmin()
    .from("approvals")
    .upsert(
      { run_id: scope.runId, project_id: scope.projectId, user_id: scope.userId, tool_call_id: r.toolCallId, token: r.token, connection_id: r.connectionId, connection: r.connection, tool: r.tool, args: redactValue(r.args), status: "waiting" },
      { onConflict: "run_id,tool_call_id", ignoreDuplicates: true },
    );
  await startSpan({ id: stableId(scope.runId, r.toolCallId, "approval"), runId: scope.runId, projectId: scope.projectId, userId: scope.userId, parentId: scope.runId, kind: "system", name: `Waiting for approval: ${r.connection} · ${r.tool}`, input: r.args });
  await emit(card(r, "waiting"));
}

/** Records the decision; "Always allow" also updates the tool's policy for this project. */
export async function settleApprovalStep(scope: RunScope, r: ApprovalRequest, decision: ApprovalDecision) {
  "use step";
  const db = supabaseAdmin();
  await db.from("approvals").update({ status: decision, decided_at: new Date().toISOString() }).eq("run_id", scope.runId).eq("tool_call_id", r.toolCallId);
  if (decision === "always") await setToolPolicies(scope.userId, scope.projectId, r.connectionId, { [r.tool]: "allow" }).catch(() => {});
  const ok = decision === "approved" || decision === "always";
  await endSpan(stableId(scope.runId, r.toolCallId, "approval"), { status: ok ? "ok" : decision === "stopped" ? "cancelled" : "error", output: { decision } });
  await emit(card(r, decision));
}
