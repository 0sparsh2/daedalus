import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let admin: SupabaseClient | undefined;

/**
 * Service-role client. Bypasses RLS, so every query must filter by user_id itself.
 * Used by the gateway, the workflow steps and other server-only code.
 */
export function supabaseAdmin(): SupabaseClient {
  admin ??= createClient(env.supabaseUrl(), env.supabaseSecretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return admin;
}
