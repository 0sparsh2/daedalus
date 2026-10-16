import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

  describe("bounded streaming calls", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env.GATEWAY_MAX_CALL_MS;
      delete process.env.GATEWAY_STOP_POLL_MS;
    });

    // An upstream that sends one chunk and then hangs, like a model stuck reasoning.
    const hangingUpstream = () =>
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const first = `data: ${JSON.stringify({ choices: [{ delta: { content: "Thinking" } }] })}\n\n`;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(first));
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      });

    const call = async (hooks: Parameters<typeof handleGateway>[2]) => {
      const t = await mintRunToken({ userId: "u", runId: "r", projectId: "p", provider: "nvidia" });
      return handleGateway(
        new Request("http://x/api/gateway/nvidia/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
          body: body({ model: "z-ai/glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }] }),
        }),
        { provider: "nvidia", path: ["chat", "completions"] },
        hooks,
      );
    };

    it("cuts a call off at the time cap with a clear SSE error", async () => {
      process.env.GATEWAY_MAX_CALL_MS = "150";
      const upstream = hangingUpstream();
      vi.stubGlobal("fetch", upstream);
      let seen: GatewayCallMeta | undefined;
      const res = await call({ resolveKey: async () => "nvapi-test", onFinish: async (_c, m) => void (seen = m) });
      const text = await res.text();
      expect(upstream).toHaveBeenCalledOnce();
      expect(text).toContain("Thinking");
      const err = JSON.parse(text.trim().split("\n").at(-1)!.slice(6));
      expect(err.error.code).toBe("gateway_timeout");
      expect(seen?.error).toMatch(/cut off/);
      expect(seen?.cancelled).toBe(false);
    });

    it("cuts a call off within one poll when the user presses Stop", async () => {
      process.env.GATEWAY_STOP_POLL_MS = "50";
      vi.stubGlobal("fetch", hangingUpstream());
      let active = true;
      let seen: GatewayCallMeta | undefined;
      const started = Date.now();
      const resP = call({ resolveKey: async () => "nvapi-test", stillActive: async () => active, onFinish: async (_c, m) => void (seen = m) });
      setTimeout(() => (active = false), 100);
      const text = await (await resP).text();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(text).toContain("run_cancelled");
      expect(text).toContain("This run was stopped.");
      expect(seen?.cancelled).toBe(true);
    });

    it("forwards the user's key upstream, never the run token", async () => {
      const upstream = vi.fn(async () => Response.json({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
      vi.stubGlobal("fetch", upstream);
      const t = await mintRunToken({ userId: "u", runId: "r", projectId: "p", provider: "nvidia" });
      const res = await handleGateway(
        new Request("http://x/api/gateway/nvidia/chat/completions", { method: "POST", headers: { authorization: `Bearer ${t}` }, body: body({ model: "m", messages: [] }) }),
        { provider: "nvidia", path: ["chat", "completions"] },
        { resolveKey: async () => "nvapi-user-key" },
      );
      expect(res.status).toBe(200);
      const [url, init] = upstream.mock.calls[0] as unknown as [URL, RequestInit];
      expect(String(url)).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer nvapi-user-key");
      expect(JSON.stringify(init.headers)).not.toContain(t);
    });
  });
});
