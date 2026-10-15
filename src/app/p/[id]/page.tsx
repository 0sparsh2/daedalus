import { notFound, redirect } from "next/navigation";
import { Workspace } from "@/components/workspace/workspace";
import { SessionProvider } from "@/lib/client/session";
import { activeRun, getProject, loadMessages } from "@/lib/projects";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getOptionalUser } from "@/lib/supabase/server";

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ mode?: string }> }) {
  const { id } = await params;
  const { mode } = await searchParams;
  const user = await getOptionalUser();
  if (!user) redirect("/");
  const project = await getProject(user.id, id).catch(() => null);
  if (!project) notFound();
  const [messages, running, checkpoints] = await Promise.all([
    loadMessages(id),
    activeRun(id),
    supabaseAdmin().from("checkpoints").select("id,sha,message,files_changed,created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(30),
  ]);
  return (
    <SessionProvider initialUser={user}>
      <Workspace
        project={{ id: project.id, name: project.name, previewUrl: project.preview_url, status: project.status, githubRepo: project.github_repo, deployUrl: project.deploy_url }}
        initialMessages={messages}
        activeRun={running ? { id: running.id, workflowRunId: running.workflow_run_id, mode: running.mode } : null}
        initialCheckpoints={checkpoints.data ?? []}
        initialMode={mode === "plan" || mode === "build" ? mode : undefined}
      />
    </SessionProvider>
  );
}
