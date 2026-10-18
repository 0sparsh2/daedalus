import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { addConnection, listConnections, refreshConnection, setToolPolicies } from "@/lib/mcp/connections";
import { getProject } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

/** Free public MCP servers (no account needed), offered with one click. Checked 2026-10-17. */
const SUGGESTED = [
  { name: "context7", url: "https://mcp.context7.com/mcp", description: "Current docs and code examples for thousands of libraries", readOnly: true },
  { name: "deepwiki", url: "https://mcp.deepwiki.com/mcp", description: "Docs and answers about any public GitHub repository", readOnly: true },
  { name: "microsoft-learn", url: "https://learn.microsoft.com/api/mcp", description: "Microsoft and Azure documentation and code samples", readOnly: true },
];

/** The project's connections (never their tokens), plus suggestions. */
export async function GET(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const connections = await listConnections(id);
    return Response.json({ connections, suggested: SUGGESTED.filter((s) => !connections.some((c) => c.url === s.url || c.name === s.name)) });
  });
}

const addSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Use a short name in lowercase letters, numbers and hyphens."),
  url: z.string().min(8).max(500),
  token: z.string().max(4000).optional(),
  readOnly: z.boolean().optional(),
});

/** Adds a connection after connecting to it and listing its tools. */
export async function POST(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const parsed = addSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid connection", "bad_request");
    const { count } = await supabaseAdmin().from("connections").select("id", { count: "exact", head: true }).eq("project_id", id);
    if ((count ?? 0) >= 10) return jsonError(400, "A project can have up to 10 connections.", "too_many");
    try {
      const r = await addConnection({ userId: user.id, projectId: id, ...parsed.data, token: parsed.data.token?.trim() || undefined });
      return Response.json({ ok: true, id: r.id, tools: r.tools.length });
    } catch (err) {
      return jsonError(400, `Couldn't connect: ${err instanceof Error ? err.message : String(err)}`, "connect_failed");
    }
  });
}

const patchSchema = z.object({
  id: z.string().uuid(),
  enabled: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  refresh: z.boolean().optional(),
  /** Per-tool permission changes; "default" goes back to what the tool's annotations suggest. */
  toolPolicies: z.record(z.string().max(128), z.enum(["allow", "ask", "block", "default"])).optional(),
});

/** Switches a connection on or off, marks it read-only, or re-checks it. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid request", "bad_request");
    const { id: connId, enabled, readOnly, refresh, toolPolicies } = parsed.data;
    if (refresh) return Response.json(await refreshConnection(user.id, connId));
    if (toolPolicies) return Response.json({ ok: true, toolPolicies: await setToolPolicies(user.id, id, connId, toolPolicies) });
    const patch: Record<string, boolean> = {};
    if (enabled !== undefined) patch.enabled = enabled;
    if (readOnly !== undefined) patch.read_only = readOnly;
    await supabaseAdmin().from("connections").update(patch).eq("id", connId).eq("project_id", id).eq("user_id", user.id);
    return Response.json({ ok: true });
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const connId = new URL(req.url).searchParams.get("id") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(connId)) return jsonError(400, "Invalid id", "bad_request");
    await supabaseAdmin().from("connections").delete().eq("id", connId).eq("project_id", id).eq("user_id", user.id);
    return Response.json({ ok: true });
  });
}
