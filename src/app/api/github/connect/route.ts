import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { githubConfigured } from "@/lib/github";
import { jsonError, withUser } from "@/lib/http";

/** Starts the GitHub OAuth flow (repo scope) with a CSRF state cookie. */
export async function GET(req: Request) {
  return withUser(async () => {
    if (!githubConfigured()) return jsonError(501, "GitHub isn't configured on this server.", "github_not_configured");
    const url = new URL(req.url);
    const next = url.searchParams.get("next") ?? "/";
    const state = randomBytes(16).toString("hex");
    (await cookies()).set("gh_oauth", JSON.stringify({ state, next: next.startsWith("/") ? next : "/" }), { httpOnly: true, sameSite: "lax", secure: url.protocol === "https:", maxAge: 600, path: "/" });
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", env.githubClientId()!);
    authorize.searchParams.set("scope", "repo");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("redirect_uri", `${url.origin}/api/github/callback`);
    return NextResponse.redirect(authorize);
  });
}
