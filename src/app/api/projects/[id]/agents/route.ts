import { z } from "zod";
import { getActiveModel } from "@/lib/credentials";
import { jsonError, withUser } from "@/lib/http";
import { PROVIDERS, getModelInfo, subagentModelFor } from "@/lib/llm/providers";
import { getProject } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** The agent team for a project: who works on it, with which model, and what they've done. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const db = supabaseAdmin();
    const [active, runs, subs, routers] = await Promise.all([
      getActiveModel(user.id),
      db.from("runs").select("mode,route,status,input_tokens,output_tokens,llm_calls,tool_calls").eq("project_id", id),
      db.from("spans").select("name,status,duration_ms").eq("project_id", id).eq("kind", "subagent"),
      db.from("spans").select("duration_ms,attrs").eq("project_id", id).eq("name", "Router"),
    ]);
    const r = runs.data ?? [];
    const settings = (project as unknown as { settings?: { subagentModel?: string } }).settings ?? {};
    const provider = active?.provider ?? "nvidia";
    const subagentModel = settings.subagentModel ?? (active ? subagentModelFor(active.provider, active.model) : null);
    const stat = (name: string) => {
      const s = (subs.data ?? []).filter((x) => x.name === name);
      return { calls: s.length, failed: s.filter((x) => x.status === "error").length, avgMs: s.length ? Math.round(s.reduce((a, x) => a + (x.duration_ms ?? 0), 0) / s.length) : 0 };
    };
    return Response.json({
      provider,
      providerLabel: PROVIDERS[provider].label,
      models: PROVIDERS[provider].models.map((m) => ({ id: m.id, label: m.label, fast: Boolean(m.fast) })),
      builder: {
        model: active?.model ?? null,
        modelLabel: active ? getModelInfo(active.provider, active.model).label : null,
        runs: r.length,
        builds: r.filter((x) => x.mode === "build").length,
        plans: r.filter((x) => x.mode === "plan").length,
        succeeded: r.filter((x) => x.status === "succeeded").length,
        toolCalls: r.reduce((a, x) => a + (x.tool_calls ?? 0), 0),
        llmCalls: r.reduce((a, x) => a + (x.llm_calls ?? 0), 0),
        inputTokens: r.reduce((a, x) => a + Number(x.input_tokens ?? 0), 0),
        outputTokens: r.reduce((a, x) => a + Number(x.output_tokens ?? 0), 0),
      },
      subagents: { model: subagentModel, research: stat("research sub-agent"), explore: stat("explore sub-agent") },
      router: {
        routes: Object.fromEntries((["chat", "ask", "plan", "build"] as const).map((k) => [k, r.filter((x) => x.route === k).length])),
        byModel: (routers.data ?? []).filter((x) => (x.attrs as { by?: string } | null)?.by === "model").length,
        byRule: (routers.data ?? []).filter((x) => ["rule", "action"].includes((x.attrs as { by?: string } | null)?.by ?? "")).length,
        avgModelMs: (() => {
          const m = (routers.data ?? []).filter((x) => (x.attrs as { by?: string } | null)?.by === "model");
          return m.length ? Math.round(m.reduce((a, x) => a + (x.duration_ms ?? 0), 0) / m.length) : 0;
        })(),
      },
    });
  });
}

const patchSchema = z.object({ subagentModel: z.string().min(1).max(120).nullable() });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid settings", "bad_request");
    const settings = { ...((project as unknown as { settings?: Record<string, unknown> }).settings ?? {}), subagentModel: parsed.data.subagentModel ?? undefined };
    await supabaseAdmin().from("projects").update({ settings }).eq("id", id).eq("user_id", user.id);
    return Response.json({ ok: true, settings });
  });
}
