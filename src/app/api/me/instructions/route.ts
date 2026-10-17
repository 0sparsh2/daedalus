import { z } from "zod";
import { jsonError, withUser } from "@/lib/http";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Your instructions for every project: how Daedalus should work with you. */
export async function GET() {
  return withUser(async (user) => {
    const { data } = await supabaseAdmin().from("profiles").select("instructions").eq("id", user.id).maybeSingle();
    return Response.json({ instructions: data?.instructions ?? "" });
  });
}

const schema = z.object({ instructions: z.string().max(8000) });

export async function PUT(req: Request) {
  return withUser(async (user) => {
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Keep your instructions under 8,000 characters.", "bad_request");
    await supabaseAdmin().from("profiles").update({ instructions: parsed.data.instructions.trim() || null }).eq("id", user.id);
    return Response.json({ ok: true });
  });
}
