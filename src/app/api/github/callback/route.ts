import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCode, saveConnection } from "@/lib/github";
import { withUser } from "@/lib/http";

export async function GET(req: Request) {
  return withUser(async (user) => {
    const url = new URL(req.url);
    const jar = await cookies();
    const saved = JSON.parse(jar.get("gh_oauth")?.value ?? "{}") as { state?: string; next?: string };
    jar.delete("gh_oauth");
    const next = saved.next ?? "/";
    if (!saved.state || saved.state !== url.searchParams.get("state")) {
      return NextResponse.redirect(new URL(`${next}?github=state_mismatch`, url.origin));
    }
    const code = url.searchParams.get("code");
    if (!code) return NextResponse.redirect(new URL(`${next}?github=cancelled`, url.origin));
    const { token, scopes } = await exchangeCode(code);
    await saveConnection(user.id, token, scopes);
    return NextResponse.redirect(new URL(`${next}?github=connected`, url.origin));
  });
}
