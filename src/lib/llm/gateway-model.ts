import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { WORKFLOW_DESERIALIZE, WORKFLOW_SERIALIZE } from "@workflow/serde";
import { PROVIDERS, type AnyProviderId } from "./providers";

/**
 * Everything needed to rebuild a model client. Plain data, so it can be written to the
 * workflow event log. `token` is a short-lived run token, never the user's API key: the
 * gateway swaps it for the decrypted key on each request.
 */
export interface GatewayModelInit {
  provider: AnyProviderId;
  modelId: string;
  /** Absolute URL of the gateway, e.g. https://daedalus.app/api/gateway */
  gatewayURL: string;
  token: string;
}

const PROVIDER_TAG: Record<string, string> = {
  "openai-compatible": "chat",
  anthropic: "messages",
  openai: "responses",
  deepseek: "chat",
};

/**
 * A provider-agnostic model that always talks to the Daedalus LLM gateway.
 *
 * Why a wrapper: durable workflows serialize the model between steps. The stock
 * OpenAI-compatible and DeepSeek clients keep their URL builder as a function, which
 * serialization drops, so a resumed step would crash. This class serializes four strings
 * and rebuilds the real client lazily inside the step that makes the call.
 */
export class GatewayModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider: string;
  readonly modelId: string;
  readonly init: GatewayModelInit;
  private inner?: LanguageModelV4;

  constructor(init: GatewayModelInit) {
    this.init = init;
    this.modelId = init.modelId;
    const kind = PROVIDERS[init.provider].kind;
    this.provider = `${init.provider}.${PROVIDER_TAG[kind]}`;
  }

  static [WORKFLOW_SERIALIZE](model: GatewayModel): GatewayModelInit {
    return { ...model.init };
  }

  static [WORKFLOW_DESERIALIZE](init: GatewayModelInit): GatewayModel {
    return new GatewayModel(init);
  }

  get supportedUrls() {
    return this.client().supportedUrls;
  }

  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult> {
    return this.client().doGenerate(options);
  }

  doStream(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4StreamResult> {
    return this.client().doStream(options);
  }

  private client(): LanguageModelV4 {
    if (!this.inner) this.inner = buildClient(this.init);
    return this.inner;
  }
}

function buildClient({ provider, modelId, gatewayURL, token }: GatewayModelInit): LanguageModelV4 {
  const baseURL = `${gatewayURL.replace(/\/$/, "")}/${provider}`;
  const headers: Record<string, string> = { "x-daedalus-client": "harness" };
  // Protected preview deployments: let the agent's server-to-server gateway calls through.
  if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  switch (PROVIDERS[provider].kind) {
    case "anthropic":
      return createAnthropic({ baseURL, apiKey: token, headers })(modelId);
    case "openai":
      return createOpenAI({ baseURL, apiKey: token, headers })(modelId);
    case "deepseek":
      return createDeepSeek({ baseURL, apiKey: token, headers })(modelId);
    case "openai-compatible":
      return createOpenAICompatible({
        name: provider,
        baseURL,
        apiKey: token,
        headers,
        includeUsage: true,
      }).chatModel(modelId);
  }
}
