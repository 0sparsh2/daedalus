import "server-only";
import { rulesSchema, type Rule } from "./rules";
import { attachProjectSandbox } from "./sandbox";
import { saveProjectSkill } from "./skills/project";
import { supabaseAdmin } from "./supabase/admin";
import type { Suggestion } from "./suggestions";

export interface SuggestionRow {
  id: string;
  kind: "skill" | "rule";
  name: string;
  payload: Record<string, unknown>;
  evidence: string;
  status: "proposed" | "kept" | "dismissed";
  run_id: string | null;
  created_at: string;
}

const COLUMNS = "id,kind,name,payload,evidence,status,run_id,created_at";

/** Equal as JSON, whatever the key order (jsonb doesn't keep it). */
function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, canon(x)])) : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** Stores a suggestion. A pending one with the same kind and name is updated, not duplicated. */
export async function proposeSuggestion(input: { userId: string; projectId: string; runId: string; suggestion: Suggestion }) {
  const db = supabaseAdmin();
  const { kind, name, payload, evidence } = input.suggestion;
  const { data: existing } = await db
    .from("suggestions")
    .select("id,status,payload")
    .eq("project_id", input.projectId)
    .eq("kind", kind)
    .eq("name", name)
    .neq("status", "dismissed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.status === "kept" && sameJson(existing.payload, payload)) {
    return { id: existing.id as string, status: "kept" as const, duplicate: true };
  }
  if (existing?.status === "proposed") {
    await db.from("suggestions").update({ payload, evidence, run_id: input.runId }).eq("id", existing.id);
    return { id: existing.id as string, status: "proposed" as const, duplicate: true };
  }
  const { data, error } = await db
    .from("suggestions")
    .insert({ user_id: input.userId, project_id: input.projectId, run_id: input.runId, kind, name, payload, evidence })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, status: "proposed" as const, duplicate: false };
}

export async function listSuggestions(projectId: string): Promise<SuggestionRow[]> {
  const { data } = await supabaseAdmin().from("suggestions").select(COLUMNS).eq("project_id", projectId).order("created_at", { ascending: false }).limit(100);
  return (data ?? []) as SuggestionRow[];
}

/**
 * Applies a kept suggestion: a skill is written to the repo (and committed, so it's a version
 * the user can restore), a rule joins the project's rules. A rule with the same label is
 * replaced, so an improved suggestion doesn't stack on the old one.
 */
export async function applySuggestion(userId: string, projectId: string, row: SuggestionRow): Promise<string> {
  const db = supabaseAdmin();
  if (row.kind === "skill") {
    const skill = row.payload as { name: string; description: string; body: string };
    const path = await saveProjectSkill(await attachProjectSandbox(projectId), skill);
    return `Saved ${path}`;
  }
  const { data: project } = await db.from("projects").select("settings").eq("id", projectId).eq("user_id", userId).single();
  const settings = (project?.settings ?? {}) as { rules?: unknown } & Record<string, unknown>;
  const current = rulesSchema.safeParse(settings.rules ?? []);
  const rules: Rule[] = (current.success ? current.data : []).filter((r) => r.label !== row.name);
  rules.push({ ...(row.payload as object), id: row.id.slice(0, 8), enabled: true } as Rule);
  const parsed = rulesSchema.safeParse(rules);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid rule");
  await db.from("projects").update({ settings: { ...settings, rules: parsed.data } }).eq("id", projectId).eq("user_id", userId);
  return "Added to Rules that always run";
}
