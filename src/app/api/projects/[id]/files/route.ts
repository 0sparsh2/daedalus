import { withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { attachProjectSandbox } from "@/lib/sandbox";

export const maxDuration = 60;

/** Flat list of project files (for the Code tab's tree). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    const project = await getProject(user.id, id);
    if (!project.sandbox_id) return Response.json({ files: [] });
    const sbx = await attachProjectSandbox(id);
    const r = await sbx.exec(
      "if command -v rg >/dev/null; then rg --files --hidden -g '!node_modules' -g '!.git' -g '!dist' -g '!.daedalus' -g '!package-lock.json'; else find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.daedalus/*' | sed 's#^\\./##'; fi | sort | head -n 1000",
      { timeoutMs: 30_000 },
    );
    return Response.json({ files: r.stdout.split("\n").filter(Boolean) });
  });
}
