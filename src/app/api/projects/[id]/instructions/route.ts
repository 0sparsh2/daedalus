import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { activeRun, getProject } from "@/lib/projects";
import { attachProjectSandbox } from "@/lib/sandbox";

export const maxDuration = 60;

/** The project's AGENTS.md: instructions the builder reads at the start of every run. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    if (!project.sandbox_id) return Response.json({ content: null });
    const sbx = await attachProjectSandbox(id);
    const bytes = await sbx.readFile("AGENTS.md");
    return Response.json({ content: bytes ? new TextDecoder().decode(bytes) : "" });
  });
}

const schema = z.object({ content: z.string().max(20_000) });

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    if (!project.sandbox_id) return jsonError(409, "Start the project first.", "no_sandbox");
    if (await activeRun(id)) return jsonError(409, "Wait for the current run to finish.", "run_in_progress");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Instructions must be under 20,000 characters.", "bad_request");
    const sbx = await attachProjectSandbox(id);
    await sbx.writeFiles([{ path: "AGENTS.md", content: parsed.data.content }]);
    await sbx.exec('git add AGENTS.md && (git diff --cached --quiet || git commit -q -m "Update project instructions")', { timeoutMs: 30_000 });
    return Response.json({ ok: true });
  });
}
