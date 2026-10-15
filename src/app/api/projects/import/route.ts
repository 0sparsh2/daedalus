import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { createProject } from "@/lib/projects";
import { lookupRepo, parseRepoUrl } from "@/lib/sandbox/importer";

const schema = z.object({ url: z.string().trim().min(3).max(300) });

/**
 * Creates a project from a GitHub repository. The repo is checked now (exists, reachable with
 * the user's GitHub access, not huge); the actual download happens in the first run's
 * sandbox step. If the user can push to the repo, Ship → Push goes back to it.
 */
export async function POST(req: Request) {
  return withUser(async (user) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Paste a GitHub repository URL", "bad_request");
    const ref = parseRepoUrl(parsed.data.url);
    if (!ref) return jsonError(400, "That isn't a GitHub repository URL (github.com/owner/repo).", "bad_url");
    const info = await lookupRepo(user.id, ref.repo, ref.ref);
    const project = await createProject(user.id, info.repo.split("/")[1], info.description ?? `Imported from github.com/${info.repo}`, {
      source: { type: "github", repo: info.repo, ref: info.ref },
      github_repo: info.canPush ? info.repo : null,
      template: "import",
    });
    return Response.json({ project, repo: info });
  });
}
