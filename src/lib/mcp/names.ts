/**
 * MCP tools are exposed to the agent as `mcp__<connection>__<tool>`. Providers accept
 * [a-zA-Z0-9_-]{1,64}, so names are sanitised and capped. Pure: shared by the workflow,
 * the API and tests.
 */
export function mcpToolKey(connection: string, tool: string): string {
  return `mcp__${connection}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export interface McpToolDescriptor {
  /** The name the agent calls. */
  key: string;
  connectionId: string;
  connection: string;
  /** The tool's own name on the MCP server. */
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

/** At most this many connection tools per run, so a large server can't flood the prompt. */
export const MAX_MCP_TOOLS = 40;
