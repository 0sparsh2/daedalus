import { beforeAll, describe, expect, it } from "vitest";
import { handleGateway, type GatewayCallMeta } from "@/lib/llm/gateway";
import { mintRunToken } from "@/lib/llm/run-token";

beforeAll(() => {
  process.env.GATEWAY_TOKEN_SECRET = "test-secret-test-secret-test-secret-123";
});

const body = (o: unknown) => JSON.stringify(o);

describe("LLM gateway", () => {
  it("rejects missing, forged and cross-provider tokens", async () => {
    const hooks = { resolveKey: async () => "k" };
    const req = (token?: string) =>
      new Request("http://x/api/gateway/mock/chat/completions", { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: body({ model: "m", messages: [] }) });
    expect((await handleGateway(req(), { provider: "mock", path: ["chat", "completions"] }, hooks)).status).toBe(401);
    expect((await handleGateway(req("forged.token.here"), { provider: "mock", path: ["chat", "completions"] }, hooks)).status).toBe(401);
    const nim = await mintRunToken({ userId: "u", runId: "r", projectId: "p", provider: "nvidia" });
    expect((await handleGateway(req(nim), { provider: "mock", path: ["chat", "completions"] }, hooks)).status).toBe(403);
  });

  it("blocks paths outside the allowlist and unknown providers", async () => {
    const t = await mintRunToken({ userId: "u", runId: "r", projectId: "p", provider: "mock" });
    const hooks = { resolveKey: async () => "k" };
    const r = new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: "{}" });
    expect((await handleGateway(r, { provider: "mock", path: ["files"] }, hooks)).status).toBe(404);
    expect((await handleGateway(r, { provider: "evil", path: ["chat", "completions"] }, hooks)).status).toBe(404);
  });

  it("streams through, meters usage and reports the call", async () => {
    const t = await mintRunToken({ userId: "u", runId: "r", projectId: "p", provider: "mock", spanId: "s1", agent: "research" });
    let seen: GatewayCallMeta | undefined;
    const res = await handleGateway(
      new Request("http://x/api/gateway/mock/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        body: body({ model: "mock-builder", stream: true, messages: [{ role: "user", content: "hi" }] }),
      }),
      { provider: "mock", path: ["chat", "completions"] },
      { resolveKey: async () => "unused", onFinish: async (_c, m) => void (seen = m) },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    const content = text
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "")
      .join("");
    expect(content).toBe("Hello from the mock model.");
    expect(text).toContain("[DONE]");
    expect(seen).toMatchObject({ provider: "mock", model: "mock-builder", stream: true, inputTokens: 120, outputTokens: 40, status: 200 });
  });

  it("refuses calls the policy hook rejects (e.g. a stopped run)", async () => {
    const { GatewayError } = await import("@/lib/llm/gateway");
    const t = await mintRunToken({ userId: "u", runId: "r", projectId: "p", provider: "mock" });
    const res = await handleGateway(
      new Request("http://x", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: body({ model: "m", messages: [] }) }),
      { provider: "mock", path: ["chat", "completions"] },
      {
        resolveKey: async () => "k",
        authorize: async () => {
          throw new GatewayError(410, "This run was stopped.", "run_cancelled");
        },
      },
    );
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("run_cancelled");
  });
});
