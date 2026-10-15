import "server-only";
import { handleMockChatCompletions, isMockEnabled } from "./mock-llm";
import { PROVIDERS, isProviderId, type AnyProviderId } from "./providers";
import { verifyRunToken, type RunTokenClaims } from "./run-token";

/**
 * The LLM gateway: the only place a user's API key is ever decrypted.
 *
 *   agent model client --(run token)--> /api/gateway/{provider}/{path} --(user key)--> provider
 *
 * Responsibilities: authenticate the run token, refuse calls for finished or cancelled runs,
 * swap the token for the user's key, forward the request with streaming intact, meter tokens
 * and latency, and record an `llm` span for the trace. Provider errors (429, 5xx) are passed
 * through unchanged so the AI SDK's retry logic (which honours Retry-After) still works.
 */

export interface GatewayCallMeta {
  provider: AnyProviderId;
  path: string;
  model?: string;
  stream: boolean;
  startedAt: number;
  firstByteAt?: number;
  endedAt?: number;
  status?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  error?: string;
  messages?: number;
  tools?: number;
}

export interface GatewayHooks {
  /** Return the decrypted key, or throw a GatewayError. Not called for the mock provider. */
  resolveKey(claims: RunTokenClaims): Promise<string>;
  /** Throw a GatewayError to refuse the call (cancelled run, budget spent, rate limit). */
  authorize?(claims: RunTokenClaims, meta: GatewayCallMeta): Promise<void>;
  onFinish?(claims: RunTokenClaims, meta: GatewayCallMeta): Promise<void>;
}

export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "gateway_error",
  ) {
    super(message);
  }
}

const FORWARD_HEADERS = ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"];
const RESPONSE_HEADERS = ["content-type", "retry-after", "x-request-id", "request-id", "anthropic-ratelimit-requests-remaining", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"];

function errorResponse(status: number, message: string, code: string) {
  // OpenAI-style error envelope; the Anthropic SDK also reads `error.message`.
  return Response.json({ error: { message, type: code, code } }, { status });
}

function tokenFrom(req: Request): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key") ?? undefined;
}

export async function handleGateway(
  req: Request,
  params: { provider: string; path: string[] },
  hooks: GatewayHooks,
): Promise<Response> {
  const providerId = params.provider;
  const path = params.path.join("/");
  if (!(isProviderId(providerId) || (providerId === "mock" && isMockEnabled()))) {
    return errorResponse(404, `Unknown provider "${providerId}"`, "unknown_provider");
  }
  const provider = PROVIDERS[providerId as AnyProviderId];
  if (!provider.allowedPaths.includes(path)) {
    return errorResponse(404, `Path "${path}" is not allowed for ${provider.label}`, "path_not_allowed");
  }

  const token = tokenFrom(req);
  if (!token) return errorResponse(401, "Missing run token", "unauthorized");
  let claims: RunTokenClaims;
  try {
    claims = await verifyRunToken(token);
  } catch {
    return errorResponse(401, "Invalid or expired run token", "unauthorized");
  }
  if (claims.provider !== provider.id) {
    return errorResponse(403, "Run token was issued for a different provider", "forbidden");
  }

  const bodyText = req.method === "GET" ? undefined : await req.text();
  const parsed = safeJson(bodyText);
  const meta: GatewayCallMeta = {
    provider: provider.id,
    path,
    model: typeof parsed?.model === "string" ? parsed.model : undefined,
    stream: parsed?.stream === true,
    startedAt: Date.now(),
    messages: Array.isArray(parsed?.messages) ? parsed.messages.length : Array.isArray(parsed?.input) ? parsed.input.length : undefined,
    tools: Array.isArray(parsed?.tools) ? parsed.tools.length : undefined,
  };

  let upstream: Response;
  try {
    await hooks.authorize?.(claims, meta);
    if (provider.id === "mock") {
      upstream = await handleMockChatCompletions(new Request("http://mock/chat/completions", { method: "POST", body: bodyText }));
    } else {
      const key = await hooks.resolveKey(claims);
      const url = new URL(`${provider.upstream}/${path}`);
      url.search = new URL(req.url).search;
      const headers = new Headers();
      for (const h of FORWARD_HEADERS) {
        const v = req.headers.get(h);
        if (v) headers.set(h, v);
      }
      if (provider.kind === "anthropic") headers.set("x-api-key", key);
      else headers.set("authorization", `Bearer ${key}`);
      upstream = await fetch(url, { method: req.method, headers, body: bodyText, signal: req.signal });
    }
  } catch (err) {
    const e = err instanceof GatewayError ? err : new GatewayError(502, `Upstream request failed: ${(err as Error).message}`, "upstream_unreachable");
    meta.status = e.status;
    meta.error = e.message;
    meta.endedAt = Date.now();
    await hooks.onFinish?.(claims, meta).catch(() => {});
    return errorResponse(e.status, e.message, e.code);
  }

  meta.status = upstream.status;
  meta.firstByteAt = Date.now();
  const outHeaders = new Headers();
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    meta.error = text.slice(0, 2000);
    meta.endedAt = Date.now();
    await hooks.onFinish?.(claims, meta).catch(() => {});
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const text = await upstream.text();
    readUsage(safeJson(text), meta);
    meta.endedAt = Date.now();
    await hooks.onFinish?.(claims, meta).catch(() => {});
    return new Response(text, { status: upstream.status, headers: outHeaders });
  }

  // Streaming: pass bytes through untouched while sniffing SSE events for usage.
  const decoder = new TextDecoder();
  let buffer = "";
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) readUsage(safeJson(line.slice(5).trim()), meta);
      }
    },
    async flush() {
      meta.endedAt = Date.now();
      await hooks.onFinish?.(claims, meta).catch(() => {});
    },
  });
  return new Response(upstream.body.pipeThrough(meter), { status: upstream.status, headers: outHeaders });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeJson(text: string | undefined): any {
  if (!text || text === "[DONE]") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads token usage from OpenAI chat/responses, Anthropic and DeepSeek payloads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readUsage(evt: any, meta: GatewayCallMeta) {
  if (!evt || typeof evt !== "object") return;
  if (!meta.model && typeof evt.model === "string") meta.model = evt.model;
  // OpenAI chat completions / DeepSeek / NIM (final chunk) and non-streaming bodies.
  const u = evt.usage ?? evt.response?.usage ?? evt.message?.usage;
  if (u) {
    if (typeof u.prompt_tokens === "number") meta.inputTokens = u.prompt_tokens;
    if (typeof u.completion_tokens === "number") meta.outputTokens = u.completion_tokens;
    if (typeof u.input_tokens === "number") meta.inputTokens = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (typeof u.output_tokens === "number") meta.outputTokens = u.output_tokens;
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens;
    if (typeof reasoning === "number") meta.reasoningTokens = reasoning;
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? u.cache_read_input_tokens;
    if (typeof cached === "number") meta.cachedInputTokens = cached;
  }
  // Anthropic streams output tokens on message_delta.
  if (evt.type === "message_delta" && typeof evt.usage?.output_tokens === "number") meta.outputTokens = evt.usage.output_tokens;
}
