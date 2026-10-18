/**
 * Per-tool permissions for connection (MCP) tools: allow, ask or block. Defaults follow the
 * server's own tool annotations (MCP spec: readOnlyHint, destructiveHint):
 *
 *   destructive          → ask, even on a connection marked "only reads data"
 *   read-only            → allow (tool hint, or the user's "only reads data" for the connection)
 *   everything else      → ask, and like today offered only in build turns
 *
 * The same allow / ask / deny shape as OpenCode's permission config and the permission rules
 * in Claude Code's public docs. Pure: used by the workflow, the API and the UI.
 */

export const TOOL_POLICIES = ["allow", "ask", "block"] as const;
export type ToolPolicy = (typeof TOOL_POLICIES)[number];

export interface ToolTraits {
  readOnly: boolean;
  destructive?: boolean;
}

/** Read-only for gating: the tool says so (or the user vouches for the connection) and it isn't destructive. */
export function isReadOnly(t: ToolTraits, connectionReadOnly: boolean): boolean {
  return !t.destructive && (t.readOnly || connectionReadOnly);
}

export function defaultPolicy(t: ToolTraits, connectionReadOnly: boolean): ToolPolicy {
  if (t.destructive) return "ask";
  return isReadOnly(t, connectionReadOnly) ? "allow" : "ask";
}

export function policyFor(name: string, t: ToolTraits, connectionReadOnly: boolean, policies: Record<string, unknown> | null | undefined): ToolPolicy {
  const set = policies?.[name];
  return TOOL_POLICIES.includes(set as ToolPolicy) ? (set as ToolPolicy) : defaultPolicy(t, connectionReadOnly);
}

/** Whether a turn offers the tool at all: never when blocked; tools that may change things only in build turns. */
export function offeredIn(route: string, policy: ToolPolicy, readOnly: boolean): boolean {
  if (policy === "block" || route === "chat" || route === "review") return false;
  return route === "build" || readOnly;
}
