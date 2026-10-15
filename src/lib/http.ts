import "server-only";
import type { User } from "@supabase/supabase-js";
import { AuthError, requireUser } from "@/lib/supabase/server";

export function jsonError(status: number, message: string, code = "error", extra: Record<string, unknown> = {}) {
  return Response.json({ error: { message, code, ...extra } }, { status });
}

/** Runs a route handler for a signed-in user; turns auth and unexpected errors into JSON. */
export async function withUser(handler: (user: User) => Promise<Response>): Promise<Response> {
  let user: User;
  try {
    ({ user } = await requireUser());
  } catch (err) {
    if (err instanceof AuthError) return jsonError(401, err.message, "unauthenticated");
    throw err;
  }
  try {
    return await handler(user);
  } catch (err) {
    if (err instanceof HttpError) return jsonError(err.status, err.message, err.code);
    console.error("[api]", err);
    return jsonError(500, err instanceof Error ? err.message : "Something went wrong", "internal");
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
  ) {
    super(message);
  }
}
