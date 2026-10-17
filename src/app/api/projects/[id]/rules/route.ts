import { jsonError, withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { rulesSchema, type RulePreset } from "@/lib/rules";
import { supabaseAdmin } from "@/lib/supabase/admin";

type Ctx = { params: Promise<{ id: string }> };

/** Ready-made rules the UI offers with one click. */
const PRESETS: RulePreset[] = [
  { event: "before_finish", label: "Run the tests before finishing", command: "npm test --if-present" },
  { event: "before_command", label: "Ask before adding packages", pattern: "npm install", reason: "Ask the user before adding or reinstalling dependencies." },
  { event: "after_change", label: "Format changed files", glob: "src/**/*.{ts,tsx,css}", command: "npx --yes prettier --write {file}" },
];

/** The project's rules that always run, plus presets. */
export async function GET(_req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const parsed = rulesSchema.safeParse(((project as unknown as { settings?: { rules?: unknown } }).settings ?? {}).rules ?? []);
    return Response.json({ rules: parsed.success ? parsed.data : [], presets: PRESETS });
  });
}

/** Replaces the project's rules. They take effect from the next model or tool step. */
export async function PUT(req: Request, ctx: Ctx) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    const body = (await req.json().catch(() => null)) as { rules?: unknown } | null;
    const parsed = rulesSchema.safeParse(body?.rules);
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid rules", "bad_request");
    const settings = { ...((project as unknown as { settings?: Record<string, unknown> }).settings ?? {}), rules: parsed.data };
    await supabaseAdmin().from("projects").update({ settings }).eq("id", id).eq("user_id", user.id);
    return Response.json({ ok: true, rules: parsed.data });
  });
}
