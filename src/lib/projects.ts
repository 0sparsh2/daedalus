import "server-only";
import type { UIMessage } from "ai";
import { HttpError } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  status: string;
  sandbox_provider: string | null;
  sandbox_id: string | null;
  preview_url: string | null;
  preview_status: string;
  github_repo: string | null;
  github_branch: string;
  github_last_sha: string | null;
  deploy_url: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function getProject(userId: string, projectId: string): Promise<ProjectRow> {
  const { data, error } = await supabaseAdmin().from("projects").select("*").eq("id", projectId).eq("user_id", userId).maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Project not found", "not_found");
  return data as ProjectRow;
}

export async function listProjects(userId: string): Promise<ProjectRow[]> {
  const { data, error } = await supabaseAdmin().from("projects").select("*").eq("user_id", userId).order("updated_at", { ascending: false }).limit(100);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []) as ProjectRow[];
}

/** A short, readable name from the first prompt ("A booking app for a small clinic" → "Booking app for a small clinic"). */
export function nameFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\[mock:[^\]]+\]/g, "").replace(/\s+/g, " ").trim();
  const words = clean.replace(/^(please\s+)?(build|make|create|design|i want|i need|can you build|can you make)\s+(me\s+)?/i, "").replace(/^(an?|the)\s+/i, "").split(" ");
  const name = words.slice(0, 6).join(" ").replace(/[.,!?;:]+$/, "");
  return name ? name[0].toUpperCase() + name.slice(1) : "Untitled app";
}

export async function createProject(userId: string, name: string, description?: string): Promise<ProjectRow> {
  const { data, error } = await supabaseAdmin().from("projects").insert({ user_id: userId, name, description: description ?? null }).select("*").single();
  if (error) throw new HttpError(500, error.message);
  return data as ProjectRow;
}

export async function loadMessages(projectId: string): Promise<UIMessage[]> {
  const { data, error } = await supabaseAdmin().from("messages").select("id,role,parts,metadata,created_at").eq("project_id", projectId).order("created_at", { ascending: true }).limit(400);
  if (error) throw new HttpError(500, error.message);
  return (data ?? []).map((m) => ({ id: m.id, role: m.role, parts: m.parts, metadata: m.metadata ?? undefined }) as UIMessage);
}

export async function activeRun(projectId: string) {
  const { data } = await supabaseAdmin()
    .from("runs")
    .select("id,workflow_run_id,status,started_at,mode")
    .eq("project_id", projectId)
    .in("status", ["queued", "running"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}
