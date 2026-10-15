import { z } from "zod";
import { deleteCredential, getActiveModel, listCredentials, saveCredential, setActiveModel, validateKey } from "@/lib/credentials";
import { jsonError, withUser } from "@/lib/http";
import { isMockEnabled } from "@/lib/llm/mock-llm";
import { PROVIDERS, PROVIDER_IDS, isProviderId, type AnyProviderId } from "@/lib/llm/providers";

/** Lists which providers the user holds keys for (never the keys) and the active model. */
export async function GET() {
  return withUser(async (user) => {
    const [credentials, active] = await Promise.all([listCredentials(user.id), getActiveModel(user.id)]);
    return Response.json({ credentials, active });
  });
}

const saveSchema = z.object({
  provider: z.enum([...PROVIDER_IDS, "mock"]),
  apiKey: z.string().trim().min(10).max(400),
  model: z.string().trim().min(1).max(120),
});

/** Validates a key with the provider, encrypts it, stores it and makes it active. */
export async function POST(req: Request) {
  return withUser(async (user) => {
    const parsed = saveSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Pick a provider and model, and paste an API key.", "bad_request");
    const { provider, apiKey, model } = parsed.data;
    if (provider === "mock" && !isMockEnabled()) return jsonError(400, "Unknown provider", "bad_request");
    const pattern = PROVIDERS[provider].keyPattern;
    if (pattern && !pattern.test(apiKey)) {
      return jsonError(422, `That doesn't look like a ${PROVIDERS[provider].label} key (expected ${PROVIDERS[provider].keyPlaceholder}).`, "bad_key_format");
    }
    const check = await validateKey(provider, apiKey, model);
    if (!check.ok) return jsonError(422, check.error ?? "The key was rejected.", "key_rejected");
    await saveCredential(user.id, provider, apiKey, model);
    return Response.json({ ok: true, active: { provider, model }, models: check.models?.slice(0, 200) });
  });
}

const activeSchema = z.object({ provider: z.string(), model: z.string().min(1).max(120) });

/** Switches the active provider/model; only providers with a stored key are allowed. */
export async function PATCH(req: Request) {
  return withUser(async (user) => {
    const parsed = activeSchema.safeParse(await req.json().catch(() => null));
    const pid = parsed.success ? parsed.data.provider : "";
    if (!parsed.success || !(isProviderId(pid) || (pid === "mock" && isMockEnabled()))) return jsonError(400, "Invalid model", "bad_request");
    const provider = pid as AnyProviderId;
    const creds = await listCredentials(user.id);
    if (!creds.some((c) => c.provider === provider && c.status === "valid")) {
      return jsonError(412, `Add your ${PROVIDERS[provider].label} key first.`, "needs_key", { provider });
    }
    await setActiveModel(user.id, provider, parsed.data.model);
    return Response.json({ ok: true, active: parsed.data });
  });
}

export async function DELETE(req: Request) {
  return withUser(async (user) => {
    const provider = new URL(req.url).searchParams.get("provider") ?? "";
    if (!isProviderId(provider) && provider !== "mock") return jsonError(400, "Unknown provider", "bad_request");
    await deleteCredential(user.id, provider);
    return Response.json({ ok: true });
  });
}
