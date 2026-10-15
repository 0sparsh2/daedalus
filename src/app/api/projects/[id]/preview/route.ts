import { withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { ensureProjectSandbox } from "@/lib/sandbox";

export const maxDuration = 300;

/** Wakes the project's sandbox (resuming a stopped one) and makes sure the dev server is up. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const { previewUrl } = await ensureProjectSandbox(id);
    return Response.json({ url: previewUrl });
  });
}
