/**
 * Secret redaction for what Daedalus stores: trace spans, saved messages, run errors and
 * summaries. It changes what's written to the database, never what the model sees during a
 * run (the model may need the key the user just pasted to wire it into their app).
 *
 * Two kinds of match:
 *   - known key formats (provider keys, GitHub and Slack tokens, AWS key ids, JWTs, PEM keys),
 *     after the public gitleaks rules and GitHub's secret-scanning patterns;
 *   - values under secret-sounding names (`*_KEY=`, `password`, `"token": "…"`).
 * No "random-looking string" detection: it would flag git SHAs, hashes and ids everywhere.
 * Pure (no server imports), so tests and the suggestion checks can use it.
 */

const MASK = "[REDACTED]";

/** Keeps a short readable prefix (`sk-a`, `ghp_`) so a trace still says what kind of key it was. */
const keepPrefix = (n: number) => (m: string) => `${m.slice(0, n)}…${MASK}`;

type Rule = { name: string; re: RegExp; replace: string | ((m: string, ...groups: string[]) => string) };

const FORMATS: Rule[] = [
  { name: "a private key", re: /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, replace: (_m, kind: string) => `-----BEGIN ${kind}PRIVATE KEY----- ${MASK} -----END ${kind}PRIVATE KEY-----` },
  { name: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: keepPrefix(7) },
  { name: "an API key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, replace: keepPrefix(3) },
  { name: "an NVIDIA API key", re: /\bnvapi-[A-Za-z0-9_-]{20,}/g, replace: keepPrefix(6) },
  { name: "a GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, replace: keepPrefix(4) },
  { name: "a GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{40,}/g, replace: keepPrefix(11) },
  { name: "an AWS access key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, replace: keepPrefix(4) },
  { name: "a Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: keepPrefix(5) },
  { name: "a Slack webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g, replace: `https://hooks.slack.com/services/${MASK}` },
  { name: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: keepPrefix(4) },
  { name: "a Stripe key", re: /\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{16,}/g, replace: keepPrefix(8) },
  { name: "a Tavily API key", re: /\btvly-[A-Za-z0-9_-]{16,}/g, replace: keepPrefix(5) },
  { name: "a Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g, replace: keepPrefix(10) },
  { name: "a JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: keepPrefix(3) },
  { name: "a bearer token", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, replace: (_m, lead: string) => `${lead}${MASK}` },
  { name: "basic auth credentials", re: /\b(Basic\s+)[A-Za-z0-9+/]{16,}={0,2}/g, replace: (_m, lead: string) => `${lead}${MASK}` },
  { name: "a password in a URL", re: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]{3,}@/gi, replace: (_m, lead: string) => `${lead}${MASK}@` },
];

const SECRET_NAME = "(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret)";

const NAMED: Rule[] = [
  // `OPENAI_API_KEY=abc…`, `export DB_PASSWORD="…"` (env files, shell, ini). Values that point
  // elsewhere ($VAR, process.env.X) aren't secrets.
  {
    name: "a secret value",
    re: new RegExp(`^(\\s*(?:export\\s+)?(?:[A-Za-z_][A-Za-z0-9_.-]*?)?${SECRET_NAME}[A-Za-z0-9_]*\\s*=\\s*)(["']?)(?!\\$|process\\.|import\\.|os\\.|<|\\{\\{)([^\\s"'#]{6,})\\2`, "gim"),
    replace: (_m, lead: string, q: string) => `${lead}${q}${MASK}${q}`,
  },
  // `"apiKey": "…"`, `password: '…'`: a quoted value under a secret-sounding key.
  {
    name: "a secret value",
    re: new RegExp(`((?:"|')?[A-Za-z0-9_-]*?${SECRET_NAME}[A-Za-z0-9_-]*(?:"|')?\\s*:\\s*)(["'])(?!\\$|\\{\\{)([^"'\\n]{6,})\\2`, "gi"),
    replace: (_m, lead: string, q: string) => `${lead}${q}${MASK}${q}`,
  },
];

const ALL = [...FORMATS, ...NAMED];

/** The text with secrets masked. */
export function redactText(text: string): string {
  let out = text;
  for (const r of ALL) out = out.replace(r.re, r.replace as (m: string, ...g: string[]) => string);
  return out;
}

/** What kind of secret the text holds, if any ("an API key"), for refusing to store it. */
export function findSecret(text: string): string | null {
  for (const r of ALL) {
    r.re.lastIndex = 0;
    if (r.re.test(text)) {
      r.re.lastIndex = 0;
      return r.name;
    }
  }
  return null;
}

/** Object keys whose string values are secrets whatever they look like. */
const SECRET_KEY = /(?:^|[_-])?(?:api[_-]?key|apikey|secret|password|passwd|private[_-]?key|access[_-]?key|authorization|client[_-]?secret)$|(?:access|auth|refresh|session|bearer|id)?[_-]?token$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Deep copy of a JSON-like value with secrets masked in strings and under secret-named keys. */
export function redactValue<T>(value: T, depth = 0): T {
  if (value == null || depth > 12) return value;
  if (typeof value === "string") return redactText(value) as T;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length >= 6 && isSecretKey(k) ? MASK : redactValue(v, depth + 1);
  }
  return out as T;
}
