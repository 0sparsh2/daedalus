import { timingSafeEqual } from "node:crypto";
import { pruneTraces, retentionDays } from "@/lib/retention";

export const maxDuration = 300;

/**
 * Daily trace cleanup, called by Vercel Cron (vercel.json). Vercel sends
 * `Authorization: Bearer $CRON_SECRET`; without the secret configured the route refuses to run.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "CRON_SECRET is not set" }, { status: 503 });
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const result = await pruneTraces();
  return Response.json({ ...result, days: retentionDays() });
}
