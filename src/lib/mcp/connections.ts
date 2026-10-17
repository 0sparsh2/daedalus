import "server-only";
import { createMCPClient } from "@ai-sdk/mcp";
import { assertPublic } from "@/lib/agent/tools/web";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { MAX_MCP_TOOLS, mcpToolKey, type McpToolDescriptor } from "./names";

/**
 * Connections: MCP servers a project's agent can use, called from Daedalus's server (never
 * from the sandbox), with the user's token decrypted only for the call.
 */

export interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface ConnectionRow {
  id: string;
  name: string;
  url: string;
  read_only: boolean;
  enabled: boolean;
  tools: CachedTool[];
  status: "ok" | "error";
  error: string | null;
  checked_at: string | null;
  created_at: string;
  secret_ciphertext?: string | null;
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

/** https only, public addresses only; plain http to localhost is allowed in development. */
export async function checkServerUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That isn't a valid address.");
  }
  const devLocal = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (devLocal) return url;
  if (url.protocol !== "https:") throw new Error("Use an https:// address.");
  await assertPublic(url);
  return url;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms))]);
}

async function connect(url: string, token?: string) {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  return withTimeout(createMCPClient({ transport: { type: "http", url, headers, redirect: "error" }, clientName: "daedalus" }), CONNECT_TIMEOUT_MS, "Connecting");
}

/** Connects and lists the server's tools (the "test connection" step). */
export async function discoverTools(url: string, token?: string): Promise<CachedTool[]> {
  const client = await connect(url, token);
  try {
    const r = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "Listing tools");
    return r.tools.map((t) => ({
      name: t.name,
      description: (t.description ?? t.annotations?.title ?? t.name).slice(0, 1024),
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      readOnly: t.annotations?.readOnlyHint === true,
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

const secretOf = (row: { secret_ciphertext?: string | null }, userId: string) => (row.secret_ciphertext ? decryptSecret(row.secret_ciphertext, userId) : undefined);

export async function listConnections(projectId: string): Promise<ConnectionRow[]> {
  const { data } = await supabaseAdmin()
    .from("connections")
    .select("id,name,url,read_only,enabled,tools,status,error,checked_at,created_at")
    .eq("project_id", projectId)
    .order("created_at");
  return (data ?? []) as ConnectionRow[];
}

export async function addConnection(input: { userId: string; projectId: string; name: string; url: string; token?: string; readOnly?: boolean }) {
  const url = await checkServerUrl(input.url);
  const tools = await discoverTools(url.toString(), input.token);
  const { data, error } = await supabaseAdmin()
    .from("connections")
    .insert({
      user_id: input.userId,
      project_id: input.projectId,
      name: input.name,
      url: url.toString(),
      secret_ciphertext: input.token ? encryptSecret(input.token, input.userId) : null,
      read_only: input.readOnly ?? false,
      tools,
      status: "ok",
      checked_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error?.code === "23505") throw new Error(`There's already a connection called ${input.name} in this project.`);
  if (error) throw new Error(error.message);
  return { id: data.id as string, tools };
}

/** Re-lists a connection's tools and records whether it's reachable. */
export async function refreshConnection(userId: string, id: string) {
  const db = supabaseAdmin();
  const { data: row } = await db.from("connections").select("url,secret_ciphertext").eq("id", id).eq("user_id", userId).maybeSingle();
  if (!row) throw new Error("No such connection");
  try {
    const tools = await discoverTools(row.url, secretOf(row, userId));
    await db.from("connections").update({ tools, status: "ok", error: null, checked_at: new Date().toISOString() }).eq("id", id);
    return { ok: true as const, tools: tools.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("connections").update({ status: "error", error: message.slice(0, 500), checked_at: new Date().toISOString() }).eq("id", id);
    return { ok: false as const, error: message };
  }
}

/** Tools for a run: enabled connections' cached tools, as plain data (no secrets). */
export async function connectionTools(projectId: string): Promise<McpToolDescriptor[]> {
  const out: McpToolDescriptor[] = [];
  for (const c of (await listConnections(projectId)).filter((c) => c.enabled && c.status === "ok")) {
    for (const t of c.tools) {
      if (out.length >= MAX_MCP_TOOLS) return out;
      out.push({ key: mcpToolKey(c.name, t.name), connectionId: c.id, connection: c.name, tool: t.name, description: `[${c.name}] ${t.description}`, inputSchema: t.inputSchema, readOnly: t.readOnly || c.read_only });
    }
  }
  return out;
}

/** Calls one tool for a run; the token is decrypted only for this call. */
export async function callConnectionTool(userId: string, connectionId: string, tool: string, args: Record<string, unknown>) {
  const { data: row } = await supabaseAdmin().from("connections").select("url,secret_ciphertext,enabled").eq("id", connectionId).eq("user_id", userId).maybeSingle();
  if (!row?.enabled) throw new Error("This connection was removed or switched off.");
  const client = await connect(row.url, secretOf(row, userId));
  try {
    const result = await withTimeout(client.callTool({ name: tool, arguments: args }), CALL_TIMEOUT_MS, `The ${tool} call`);
    const content = (result.content ?? []) as Array<{ type: string; text?: string; resource?: { uri?: string; text?: string } }>;
    const text = content
      .map((c) => (c.type === "text" ? c.text : c.type === "resource" ? (c.resource?.text ?? c.resource?.uri) : `[${c.type}]`))
      .filter(Boolean)
      .join("\n");
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    return { isError: Boolean(result.isError), text: text || (structured ? JSON.stringify(structured) : "(no output)") };
  } finally {
    await client.close().catch(() => {});
  }
}
