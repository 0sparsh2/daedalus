import "server-only";
import { getDecryptedKey, markCredentialInvalid } from "@/lib/credentials";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { addRunUsage, recordSpan } from "@/lib/trace/spans";
import { GatewayError, type GatewayHooks } from "./gateway";
import { PROVIDERS, isProviderId } from "./providers";

/** Production gateway policy: Postgres-backed keys, run checks, metering and llm spans. */
export const gatewayHooks: GatewayHooks = {
  async resolveKey(claims) {
    if (!isProviderId(claims.provider)) throw new GatewayError(400, "Unknown provider", "unknown_provider");
    const key = await getDecryptedKey(claims.userId, claims.provider);
    if (!key) {
      throw new GatewayError(401, `No working ${PROVIDERS[claims.provider].label} key on file. Add one in Settings → Models.`, "missing_key");
    }
    return key;
  },

  async authorize(claims) {
    const { data, error } = await supabaseAdmin()
      .from("runs")
      .select("status,user_id")
      .eq("id", claims.runId)
      .maybeSingle();
    if (error) throw new GatewayError(503, "Run lookup failed", "unavailable");
    if (!data || data.user_id !== claims.userId) throw new GatewayError(403, "Unknown run", "forbidden");
    if (data.status === "cancelled") throw new GatewayError(409, "This run was stopped.", "run_cancelled");
    if (data.status === "succeeded" || data.status === "failed") {
      throw new GatewayError(409, "This run has already finished.", "run_finished");
    }
  },

  async onFinish(claims, meta) {
    const ok = meta.status != null && meta.status < 400 && !meta.error;
    if (meta.status === 401 && isProviderId(claims.provider) && claims.provider !== undefined) {
      await markCredentialInvalid(claims.userId, claims.provider, meta.error ?? "401 from provider");
    }
    await Promise.all([
      recordSpan({
        runId: claims.runId,
        projectId: claims.projectId,
        userId: claims.userId,
        parentId: claims.spanId ?? claims.runId,
        kind: "llm",
        name: meta.model ?? "model call",
        status: ok ? "ok" : "error",
        startedAt: new Date(meta.startedAt),
        endedAt: new Date(meta.endedAt ?? Date.now()),
        error: ok ? undefined : meta.error ?? `HTTP ${meta.status}`,
        attrs: {
          provider: meta.provider,
          model: meta.model,
          agent: claims.agent ?? "builder",
          httpStatus: meta.status,
          stream: meta.stream,
          ttfbMs: meta.firstByteAt ? meta.firstByteAt - meta.startedAt : undefined,
          inputTokens: meta.inputTokens,
          outputTokens: meta.outputTokens,
          reasoningTokens: meta.reasoningTokens,
          cachedInputTokens: meta.cachedInputTokens,
          messages: meta.messages,
          tools: meta.tools,
        },
      }),
      addRunUsage(claims.runId, { input: meta.inputTokens, output: meta.outputTokens, llmCalls: 1 }),
    ]);
  },
};
