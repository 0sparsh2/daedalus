/**
 * Provider registry. Shared by the browser (sign-up pop-up, model picker) and the server
 * (gateway, model factory). Holds no secrets: users bring their own keys, which only the
 * gateway ever decrypts.
 */

export const PROVIDER_IDS = ["nvidia", "anthropic", "openai", "deepseek"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
/** `mock` is a scripted OpenAI-compatible server used by tests and local development. */
export type AnyProviderId = ProviderId | "mock";

export type ProviderKind = "openai-compatible" | "anthropic" | "openai" | "deepseek";

export interface ModelInfo {
  id: string;
  label: string;
  /** Context window in tokens; drives compaction thresholds. */
  context: number;
  /** Output budget per model call. Set explicitly: some providers default to ~1k, which truncates file writes. */
  maxOutput?: number;
  /** Tool calling verified end-to-end with the Daedalus harness. */
  verified?: boolean;
  /** Fast, cheaper model used for sub-agents (research / explore) by default. */
  fast?: boolean;
  /** Emits reasoning tokens. */
  reasoning?: boolean;
  note?: string;
}

export interface ProviderInfo {
  id: AnyProviderId;
  label: string;
  kind: ProviderKind;
  /** Upstream API base the gateway forwards to. */
  upstream: string;
  /** Paths (relative to upstream) the gateway is allowed to forward. */
  allowedPaths: string[];
  keyPlaceholder: string;
  keyPattern?: RegExp;
  keyUrl: string;
  models: ModelInfo[];
  defaultModel: string;
}

export const PROVIDERS: Record<AnyProviderId, ProviderInfo> = {
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    kind: "openai-compatible",
    upstream: "https://integrate.api.nvidia.com/v1",
    allowedPaths: ["chat/completions", "models"],
    keyPlaceholder: "nvapi-…",
    keyPattern: /^nvapi-[A-Za-z0-9_\-]{20,}$/,
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    defaultModel: "z-ai/glm-5.3",
    // Order matters: the first `fast` model runs the sub-agents. Verified = tool calling checked
    // end to end (scripts/probe-nim.mjs). Free-tier availability varies by account and hour.
    models: [
      { id: "z-ai/glm-5.3", label: "GLM-5.3", context: 200_000, reasoning: true, verified: true },
      { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super", context: 128_000, reasoning: true, verified: true },
      { id: "openai/gpt-oss-20b", label: "gpt-oss-20b", context: 128_000, fast: true, reasoning: true, verified: true, maxOutput: 8_192 },
      { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", context: 256_000 },
      { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra", context: 128_000, reasoning: true },
      { id: "z-ai/glm-5.3-flash", label: "GLM-5.3 Flash", context: 128_000, fast: true },
      { id: "deepseek-ai/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", context: 128_000, fast: true },
      { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning", context: 128_000, fast: true },
      { id: "poolside/laguna-xs-2.1", label: "Laguna XS 2.1", context: 128_000 },
      { id: "mistralai/mistral-large-2-instruct", label: "Mistral Large 2", context: 128_000 },
      { id: "google/gemma-4-31b-it", label: "Gemma 4 31B", context: 128_000 },
    ],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    upstream: "https://api.anthropic.com/v1",
    allowedPaths: ["messages", "models"],
    keyPlaceholder: "sk-ant-…",
    keyPattern: /^sk-ant-[A-Za-z0-9_\-]{20,}$/,
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-5-5",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", context: 200_000, reasoning: true },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", context: 200_000, reasoning: true },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1", context: 200_000, reasoning: true },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", context: 200_000, fast: true },
    ],
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    upstream: "https://api.openai.com/v1",
    allowedPaths: ["responses", "chat/completions", "models"],
    keyPlaceholder: "sk-…",
    keyPattern: /^sk-[A-Za-z0-9_\-]{20,}$/,
    keyUrl: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-6-sol",
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", context: 400_000, reasoning: true },
      { id: "gpt-6-sol", label: "GPT-6 Sol", context: 400_000, reasoning: true },
      { id: "gpt-6-luna", label: "GPT-6 Luna", context: 400_000, fast: true, reasoning: true },
      { id: "gpt-5.5", label: "GPT-5.5", context: 400_000, reasoning: true },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini", context: 400_000, fast: true, reasoning: true },
    ],
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    kind: "deepseek",
    upstream: "https://api.deepseek.com",
    allowedPaths: ["chat/completions", "models"],
    keyPlaceholder: "sk-…",
    keyPattern: /^sk-[A-Za-z0-9]{20,}$/,
    keyUrl: "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-v4-pro",
    models: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", context: 128_000, reasoning: true },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", context: 128_000, fast: true },
    ],
  },
  mock: {
    id: "mock",
    label: "Mock (tests)",
    kind: "openai-compatible",
    upstream: "internal:mock",
    allowedPaths: ["chat/completions", "models"],
    keyPlaceholder: "mock-key-for-tests",
    keyUrl: "https://github.com/",
    defaultModel: "mock-builder",
    models: [{ id: "mock-builder", label: "Mock builder", context: 64_000, verified: true, fast: true }],
  },
};

/** Providers offered in the UI. The mock appears only in development/test builds. */
export function selectableProviders(): AnyProviderId[] {
  return process.env.NEXT_PUBLIC_ENABLE_MOCK_PROVIDER === "1" ? [...PROVIDER_IDS, "mock"] : [...PROVIDER_IDS];
}

export function isProviderId(v: string): v is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(v);
}

export function getModelInfo(provider: AnyProviderId, modelId: string): ModelInfo {
  const p = PROVIDERS[provider];
  return (
    p.models.find((m) => m.id === modelId) ?? {
      id: modelId,
      label: modelId,
      context: 128_000,
      note: "Not in the curated list; tool calling unverified.",
    }
  );
}

/** The model sub-agents use: the provider's first `fast` model, else the main model. */
export function maxOutputFor(provider: AnyProviderId, modelId: string): number {
  const m = getModelInfo(provider, modelId);
  return m.maxOutput ?? (m.fast ? 8_192 : 16_384);
}

export function subagentModelFor(provider: AnyProviderId, mainModel: string): string {
  return PROVIDERS[provider].models.find((m) => m.fast)?.id ?? mainModel;
}
