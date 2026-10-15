import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Envelope for secrets at rest (users' model API keys, GitHub tokens): AES-256-GCM with a
 * random 96-bit IV and the user id as additional authenticated data, so a ciphertext copied
 * onto another user's row fails to decrypt. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 * The encryption key comes from the environment (a KMS in production), never the database.
 */
const VERSION = "v1";

function key(): Buffer {
  const k = Buffer.from(env.encryptionKey(), "base64");
  if (k.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encryptSecret(plaintext: string, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(envelope: string, userId: string): string {
  const [version, iv, tag, ct] = envelope.split(".");
  if (version !== VERSION || !iv || !tag || !ct) throw new Error("Unrecognised secret envelope");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function last4(secret: string): string {
  return secret.slice(-4);
}
