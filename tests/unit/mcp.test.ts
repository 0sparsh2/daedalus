import { describe, expect, it } from "vitest";
import { mcpToolKey } from "@/lib/mcp/names";

describe("connection tool names", () => {
  it("namespaces tools by connection and keeps provider-safe characters", () => {
    expect(mcpToolKey("context7", "resolve-library-id")).toBe("mcp__context7__resolve-library-id");
    expect(mcpToolKey("my-crm", "contacts.search")).toBe("mcp__my-crm__contacts_search");
    expect(mcpToolKey("x", "a".repeat(100))).toHaveLength(64);
    expect(mcpToolKey("x", "a b/c")).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
