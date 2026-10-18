import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { applyProjectNetwork, attachProjectSandbox, sandboxProvider } from "@/lib/sandbox";
import { DEFAULT_SANDBOX_DOMAINS, MAX_EXTRA_DOMAINS, normalizeDomain } from "@/lib/sandbox/network";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };
type Settings = { sandboxDomains?: string[] } & Record<string, unknown>;
const settingsOf = (p: unknown) => ((p as { settings?: Settings }).settings ?? {}) as Settings;
const enforced = () => sandboxProvider().name === "vercel" && process.env.SANDBOX_NETWORK !== "open";

/** What the project's sandbox may reach: the defaults, the domains the user added, and whether it's enforced here. */
export async function GET(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    return Response.json({ defaults: DEFAULT_SANDBOX_DOMAINS, domains: settingsOf(project).sandboxDomains ?? [], enforced: enforced(), provider: sandboxProvider().name });
  });
}

const putSchema = z.object({ domains: z.array(z.string().max(253)).max(MAX_EXTRA_DOMAINS) });

/** Replaces the added domains and applies them to the running sandbox straight away. */
export async function PUT(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const parsed = putSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, `Up to ${MAX_EXTRA_DOMAINS} domains.`, "bad_request");
    const bad = parsed.data.domains.filter((d) => !normalizeDomain(d));
    if (bad.length) return jsonError(400, `Not a domain: ${bad.slice(0, 3).join(", ")}. Use a name like api.example.com or *.example.com.`, "bad_domain");
    const domains = [...new Set(parsed.data.domains.map((d) => normalizeDomain(d)!))].filter((d) => !(DEFAULT_SANDBOX_DOMAINS as readonly string[]).includes(d));
    await supabaseAdmin().from("projects").update({ settings: { ...settingsOf(project), sandboxDomains: domains } }).eq("id", id).eq("user_id", user.id);
    let applied: string = "later";
    if (project.sandbox_id) applied = await applyProjectNetwork(id, await attachProjectSandbox(id)).catch(() => "later");
    return Response.json({ ok: true, domains, applied, enforced: enforced() });
  });
}
