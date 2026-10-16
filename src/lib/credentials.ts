import "server-only";
import { decryptSecret, encryptSecret, last4 } from "@/lib/crypto";
import { isMockEnabled } from "@/lib/llm/mock-llm";
import { PROVIDERS, type AnyProviderId } from "@/lib/llm/providers";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface CredentialSummary {
  provider: AnyProviderId;
  last4: string;
  defaultModel: string;
  status: "valid" | "invalid";
  updatedAt: string;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  warning?: string;
  /** Live model ids the key can use, when the provider lists them. */
  models?: string[];
}

const TIMEOUT_MS = 20_000;

async function call(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const j = JSON.parse(body);
    return j.error?.message ?? j.detail ?? j.message ?? body.slice(0, 300);
  } catch {
    return body.slice(0, 300) || res.statusText;
  }
}

/**
 * Checks a key against the provider before we store it. Listing models is free and proves
 * the key is live; NVIDIA's model list is public, so for NIM we make a 1-token completion
 * with the chosen model instead (which also proves the account can reach that model).
 */
export async function validateKey(provider: AnyProviderId, apiKey: string, model: string): Promise<ValidationResult> {
  const p = PROVIDERS[provider];
  if (provider === "mock") {
    return isMockEnabled() && apiKey.length >= 10 ? { ok: true, models: PROVIDERS.mock.models.map((m) => m.id) } : { ok: false, error: "The mock provider is disabled on this server." };
  }
  try {
    if (provider === "nvidia") {
      const ping = (m: string) =>
        call(`${p.upstream}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: m, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
        });
      let res: Response | null = null;
      try {
        res = await ping(model);
      } catch {
        res = null; // timed out: the model is busy, not necessarily the key
      }
      if (res && (res.status === 401 || res.status === 403)) return { ok: false, error: "NVIDIA rejected this key." };
      if (res && res.status === 404) return { ok: false, error: `This key can't reach ${model}. Pick another model.` };
      if (res?.ok) return { ok: true };
      // Busy or overloaded (timeout, 429, 5xx): check the key on a small, usually-free model instead.
      const fallback = await ping("openai/gpt-oss-20b").catch(() => null);
      if (fallback && (fallback.status === 401 || fallback.status === 403)) return { ok: false, error: "NVIDIA rejected this key." };
      if (fallback?.ok) return { ok: true, warning: `Your key works, but ${model} is busy on NVIDIA right now. If runs are slow, pick another model.` };
      return { ok: false, error: `NVIDIA is busy right now (${res ? `HTTP ${res.status}` : "timed out"}). Try again in a minute or pick another model.` };
    }
    if (provider === "anthropic") {
      const res = await call(`${p.upstream}/models?limit=100`, {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: "Anthropic rejected this key." };
      if (!res.ok) return { ok: false, error: `Anthropic returned ${res.status}: ${await errorText(res)}` };
      const j = (await res.json()) as { data?: Array<{ id: string }> };
      return { ok: true, models: (j.data ?? []).map((m) => m.id) };
    }
    // OpenAI and DeepSeek: GET /models with a bearer key.
    const res = await call(`${p.upstream}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `${p.label} rejected this key.` };
    if (!res.ok) return { ok: false, error: `${p.label} returned ${res.status}: ${await errorText(res)}` };
    const j = (await res.json()) as { data?: Array<{ id: string }> };
    return { ok: true, models: (j.data ?? []).map((m) => m.id) };
  } catch (err) {
    const msg = (err as Error).name === "TimeoutError" ? "timed out" : (err as Error).message;
    return { ok: false, error: `Couldn't reach ${p.label}: ${msg}` };
  }
}

export async function saveCredential(userId: string, provider: AnyProviderId, apiKey: string, model: string) {
  const db = supabaseAdmin();
  const { error } = await db.from("credentials").upsert(
    {
      user_id: userId,
      provider,
      key_ciphertext: encryptSecret(apiKey, userId),
      key_last4: last4(apiKey),
      default_model: model,
      status: "valid",
      last_validated_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "user_id,provider" },
  );
  if (error) throw new Error(`Couldn't save the key: ${error.message}`);
  await setActiveModel(userId, provider, model);
}

export async function setActiveModel(userId: string, provider: AnyProviderId, model: string) {
  const db = supabaseAdmin();
  const { error } = await db.from("profiles").upsert({ id: userId, active_provider: provider, active_model: model }, { onConflict: "id" });
  if (error) throw new Error(`Couldn't update the model: ${error.message}`);
  await db.from("credentials").update({ default_model: model }).eq("user_id", userId).eq("provider", provider);
}

export async function listCredentials(userId: string): Promise<CredentialSummary[]> {
  const { data, error } = await supabaseAdmin()
    .from("credentials")
    .select("provider,key_last4,default_model,status,updated_at")
    .eq("user_id", userId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    provider: r.provider as AnyProviderId,
    last4: r.key_last4,
    defaultModel: r.default_model,
    status: r.status,
    updatedAt: r.updated_at,
  }));
}

export async function getActiveModel(userId: string): Promise<{ provider: AnyProviderId; model: string } | null> {
  const db = supabaseAdmin();
  const [{ data: profile }, creds] = await Promise.all([
    db.from("profiles").select("active_provider,active_model").eq("id", userId).maybeSingle(),
    listCredentials(userId),
  ]);
  const usable = creds.filter((c) => c.status === "valid" && (c.provider !== "mock" || isMockEnabled()));
  const active = usable.find((c) => c.provider === profile?.active_provider);
  if (active) return { provider: active.provider, model: profile?.active_model ?? active.defaultModel };
  const first = usable[0];
  return first ? { provider: first.provider, model: first.defaultModel } : null;
}

/** Only the gateway calls this. The plaintext never leaves that request. */
export async function getDecryptedKey(userId: string, provider: AnyProviderId): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from("credentials")
    .select("key_ciphertext,status")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.status !== "valid") return null;
  return decryptSecret(data.key_ciphertext, userId);
}

export async function markCredentialInvalid(userId: string, provider: AnyProviderId, reason: string) {
  await supabaseAdmin()
    .from("credentials")
    .update({ status: "invalid", last_error: reason.slice(0, 500) })
    .eq("user_id", userId)
    .eq("provider", provider);
}

export async function deleteCredential(userId: string, provider: AnyProviderId) {
  const { error } = await supabaseAdmin().from("credentials").delete().eq("user_id", userId).eq("provider", provider);
  if (error) throw new Error(error.message);
}
