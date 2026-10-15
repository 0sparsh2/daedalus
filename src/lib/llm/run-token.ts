import { SignJWT, jwtVerify } from "jose";
import type { AnyProviderId } from "./providers";

/**
 * Run tokens are what the agent's model client sends as its "API key". They are signed by
 * the server, scoped to one run (and optionally one span, so sub-agent calls nest in the
 * trace), and useless anywhere except our gateway. The user's real key stays encrypted in
 * Postgres and is decrypted only inside the gateway request.
 */
export interface RunTokenClaims {
  userId: string;
  runId: string;
  projectId: string;
  provider: AnyProviderId;
  /** Parent span for model calls made with this token (main loop or a sub-agent). */
  spanId?: string;
  /** Short label shown in the trace for calls made with this token. */
  agent?: string;
}

const ISSUER = "daedalus";
const AUDIENCE = "daedalus-gateway";

function secret(): Uint8Array {
  const s = process.env.GATEWAY_TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error("GATEWAY_TOKEN_SECRET must be set (32+ chars)");
  return new TextEncoder().encode(s);
}

export async function mintRunToken(claims: RunTokenClaims, ttlSeconds = 6 * 60 * 60): Promise<string> {
  return new SignJWT({
    run: claims.runId,
    prj: claims.projectId,
    prv: claims.provider,
    ...(claims.spanId ? { spn: claims.spanId } : {}),
    ...(claims.agent ? { agt: claims.agent } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret());
}

export async function verifyRunToken(token: string): Promise<RunTokenClaims> {
  const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: AUDIENCE });
  return {
    userId: String(payload.sub),
    runId: String(payload.run),
    projectId: String(payload.prj),
    provider: payload.prv as AnyProviderId,
    spanId: typeof payload.spn === "string" ? payload.spn : undefined,
    agent: typeof payload.agt === "string" ? payload.agt : undefined,
  };
}
