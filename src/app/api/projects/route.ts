import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { createProject, listProjects, nameFromPrompt } from "@/lib/projects";

export async function GET() {
  return withUser(async (user) => Response.json({ projects: await listProjects(user.id) }));
}

const createSchema = z.object({ prompt: z.string().trim().min(1).max(8000) });

/** Creates a project from the first prompt; the workspace then sends that prompt as the first run. */
export async function POST(req: Request) {
  return withUser(async (user) => {
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Describe what you want to build", "bad_request");
    const project = await createProject(user.id, nameFromPrompt(parsed.data.prompt), parsed.data.prompt.slice(0, 500));
    return Response.json({ project });
  });
}
