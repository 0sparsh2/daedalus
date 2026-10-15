import { jsonError, withUser } from "@/lib/http";
import { getProject } from "@/lib/projects";
import { attachProjectSandbox } from "@/lib/sandbox";

export const maxDuration = 60;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withUser(async (user) => {
    const { id } = await ctx.params;
    await getProject(user.id, id);
    const path = new URL(req.url).searchParams.get("path");
    if (!path) return jsonError(400, "path is required", "bad_request");
    const sbx = await attachProjectSandbox(id);
    const bytes = await sbx.readFile(path).catch((e: Error) => {
      throw Object.assign(new Error(e.message), { status: 400 });
    });
    if (!bytes) return jsonError(404, "File not found", "not_found");
    if (bytes.subarray(0, 8000).includes(0)) return Response.json({ path, binary: true, size: bytes.length });
    return Response.json({ path, content: new TextDecoder().decode(bytes).slice(0, 400_000), size: bytes.length });
  });
}
