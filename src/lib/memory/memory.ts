import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * Memory the user controls. The agent can only *propose* a memory (the remember tool); it
 * shows in the chat as a card with Keep and Discard, and only kept memories reach the prompt.
 * Project memories belong to one project; "me" memories follow the user across projects.
 */

export interface MemoryRow {
  id: string;
  project_id: string | null;
  text: string;
  source: "agent" | "user";
  status: "proposed" | "kept" | "dismissed";
  created_at: string;
}

/** Cap on what's loaded into a prompt, newest first. */
const MAX_LOADED = 40;

export async function memoriesFor(userId: string, projectId: string): Promise<MemoryRow[]> {
  const { data } = await supabaseAdmin()
    .from("memories")
    .select("id,project_id,text,source,status,created_at")
    .eq("user_id", userId)
    .or(`project_id.eq.${projectId},project_id.is.null`)
    .neq("status", "dismissed")
    .order("created_at", { ascending: false })
    .limit(200);
  return (data ?? []) as MemoryRow[];
}

/** The prompt section: the user's instructions and kept memories. */
export async function memoryContext(userId: string, projectId: string): Promise<{ instructions?: string; memories: string[] }> {
  const db = supabaseAdmin();
  const [{ data: profile }, rows] = await Promise.all([db.from("profiles").select("instructions").eq("id", userId).maybeSingle(), memoriesFor(userId, projectId)]);
  const kept = rows.filter((m) => m.status === "kept").slice(0, MAX_LOADED);
  return {
    instructions: profile?.instructions?.trim() || undefined,
    memories: kept.map((m) => `${m.text}${m.project_id ? "" : " (applies to all projects)"}`),
  };
}

export async function proposeMemory(input: { userId: string; projectId: string; runId: string; text: string; scope: "project" | "me" }) {
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
  const db = supabaseAdmin();
  // The same fact twice is one memory.
  const { data: existing } = await db.from("memories").select("id,status").eq("user_id", input.userId).eq("text", text).neq("status", "dismissed").limit(1).maybeSingle();
  if (existing) return { id: existing.id as string, status: existing.status as MemoryRow["status"], duplicate: true };
  const { data, error } = await db
    .from("memories")
    .insert({ user_id: input.userId, project_id: input.scope === "me" ? null : input.projectId, text, source: "agent", status: "proposed", run_id: input.runId })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id as string, status: "proposed" as const, duplicate: false };
}
