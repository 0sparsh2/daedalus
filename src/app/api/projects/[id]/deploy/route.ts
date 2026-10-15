import { deployProject } from "@/lib/deploy";
import { jsonError, withUser } from "@/lib/http";
import { activeRun, getProject } from "@/lib/projects";
import { attachProjectSandbox } from "@/lib/sandbox";

export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    if (await activeRun(id)) return jsonError(409, "Wait for the current run to finish before deploying.", "run_in_progress");
    const sandbox = await attachProjectSandbox(id);
    return Response.json(await deployProject(user.id, project, sandbox));
  });
}
