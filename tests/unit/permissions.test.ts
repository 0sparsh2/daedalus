import { afterEach, describe, expect, it } from "vitest";
import { defaultPolicy, isReadOnly, offeredIn, policyFor } from "@/lib/mcp/policy";
import { allowedDomains, normalizeDomain, sandboxNetworkPolicy } from "@/lib/sandbox/network";

describe("connection tool permissions", () => {
  it("defaults follow the server's annotations", () => {
    expect(defaultPolicy({ readOnly: true }, false)).toBe("allow");
    expect(defaultPolicy({ readOnly: false }, false)).toBe("ask");
    expect(defaultPolicy({ readOnly: false }, true)).toBe("allow");
    // Destructive wins over the user's "only reads data" and over a stray readOnlyHint.
    expect(defaultPolicy({ readOnly: true, destructive: true }, true)).toBe("ask");
    expect(isReadOnly({ readOnly: true, destructive: true }, true)).toBe(false);
  });
  it("an explicit choice beats the default; junk values don't", () => {
    expect(policyFor("search", { readOnly: true }, false, { search: "block" })).toBe("block");
    expect(policyFor("send", { readOnly: false }, false, { send: "allow" })).toBe("allow");
    expect(policyFor("send", { readOnly: false }, false, { send: "sometimes" })).toBe("ask");
  });
  it("offers tools by turn: never blocked ones, changes only while building", () => {
    expect(offeredIn("plan", "allow", true)).toBe(true);
    expect(offeredIn("plan", "ask", false)).toBe(false);
    expect(offeredIn("build", "ask", false)).toBe(true);
    expect(offeredIn("build", "block", true)).toBe(false);
    expect(offeredIn("chat", "allow", true)).toBe(false);
    expect(offeredIn("review", "allow", true)).toBe(false);
  });
});

describe("sandbox network allowlist", () => {
  afterEach(() => {
    delete process.env.SANDBOX_NETWORK;
  });
  it("accepts domains and wildcards, refuses everything else", () => {
    expect(normalizeDomain("https://API.OpenWeatherMap.org/data/2.5")).toBe("api.openweathermap.org");
    expect(normalizeDomain("*.supabase.co")).toBe("*.supabase.co");
    for (const bad of ["localhost", "*", "*.com", "10.0.0.1", "db.internal", "printer.local", "exa mple.com", "-bad.com", ""]) expect(normalizeDomain(bad)).toBeNull();
  });
  it("always includes npm and GitHub, deduplicated", () => {
    const list = allowedDomains(["api.example.com", "API.example.com", "registry.npmjs.org", "nope"]);
    expect(list).toContain("registry.npmjs.org");
    expect(list).toContain("github.com");
    expect(list.filter((d) => d === "api.example.com")).toHaveLength(1);
    expect(list).not.toContain("nope");
  });
  it("can be opened up only explicitly", () => {
    expect(sandboxNetworkPolicy([])).toMatchObject({ allow: expect.arrayContaining(["registry.npmjs.org"]) });
    process.env.SANDBOX_NETWORK = "open";
    expect(sandboxNetworkPolicy([])).toBe("allow-all");
  });
});
