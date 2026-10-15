import { HomeClient } from "@/components/home";
import { SessionProvider } from "@/lib/client/session";
import { listProjects } from "@/lib/projects";
import { getOptionalUser } from "@/lib/supabase/server";

export default async function HomePage() {
  const user = await getOptionalUser();
  const projects = user ? await listProjects(user.id).catch(() => []) : [];
  return (
    <SessionProvider initialUser={user}>
      <HomeClient projects={projects.map((p) => ({ id: p.id, name: p.name, status: p.status, updated_at: p.updated_at, description: p.description }))} />
    </SessionProvider>
  );
}
