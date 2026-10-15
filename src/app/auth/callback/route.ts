import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";

/** OAuth / magic-link landing: exchanges the code for a session, then returns to the app. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  if (code) {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error.message)}`, url.origin));
  }
  return NextResponse.redirect(new URL(safeNext, url.origin));
}
