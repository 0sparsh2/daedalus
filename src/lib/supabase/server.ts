import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { env } from "@/lib/env";

/** Supabase client acting as the signed-in user (RLS applies). */
export async function createSupabaseServer() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The proxy refreshes them.
        }
      },
    },
  });
}

export class AuthError extends Error {
  status = 401;
}

/** Returns the verified user or throws AuthError. Use in route handlers and server actions. */
export async function requireUser() {
  const supabase = await createSupabaseServer();
  // API clients and tests may send the Supabase access token instead of cookies.
  const auth = (await headers()).get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : undefined;
  const { data, error } = bearer ? await supabase.auth.getUser(bearer) : await supabase.auth.getUser();
  if (error || !data.user) throw new AuthError("Sign in to continue");
  return { user: data.user, supabase };
}

export async function getOptionalUser() {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}
