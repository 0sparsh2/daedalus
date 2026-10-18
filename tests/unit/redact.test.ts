import { describe, expect, it } from "vitest";
import { findSecret, redactText, redactValue } from "@/lib/redact";
import { normalizeSuggestion } from "@/lib/suggestions";

// Fake keys are assembled at runtime so no literal key-shaped string sits in the repo.
const fake = (prefix: string, n: number, alphabet = "aB3dE5fG7h") => prefix + Array.from({ length: n }, (_, i) => alphabet[i % alphabet.length]).join("");

const SECRETS: Array<[string, string]> = [
  ["anthropic", fake("sk-" + "ant-api03-", 40)],
  ["openai", fake("sk-" + "proj-", 40)],
  ["deepseek", fake("sk-", 32)],
  ["nvidia", fake("nv" + "api-", 40)],
  ["github classic", fake("gh" + "p_", 36)],
  ["github fine-grained", fake("github" + "_pat_", 60)],
  ["aws key id", fake("AK" + "IA", 16, "ABCDEFGHIJKLMNOP2345")],
  ["slack", fake("xo" + "xb-", 30)],
  ["google", fake("AI" + "za", 35)],
  ["stripe", fake("sk" + "_live_", 24)],
  ["tavily", fake("tv" + "ly-", 24)],
  ["supabase", fake("sb" + "_secret_", 30)],
  ["jwt", `${fake("ey" + "J", 20)}.${fake("ey" + "J", 30)}.${fake("", 30)}`],
];

describe("redaction", () => {
  it.each(SECRETS)("masks a %s key wherever it appears", (_name, key) => {
    const text = `Here it is: ${key} (keep it safe)`;
    const out = redactText(text);
    expect(out).not.toContain(key);
    expect(out).toContain("[REDACTED]");
    expect(out).toMatch(/^Here it is: .+ \(keep it safe\)$/);
    expect(findSecret(text)).not.toBeNull();
  });

  it("masks headers, URLs, PEM blocks and secret-named values", () => {
    const pem = ["-----BEGIN RSA PRIVATE KEY-----", fake("", 64), fake("", 64), "-----END RSA PRIVATE KEY-----"].join("\n");
    const cases: Array<[string, string]> = [
      [`Authorization: Bearer ${fake("", 32)}`, "Authorization: Bearer [REDACTED]"],
      [`postgres://app:${fake("", 12)}@db.internal:5432/app`, "postgres://app:[REDACTED]@db.internal:5432/app"],
      [pem, "-----BEGIN RSA PRIVATE KEY----- [REDACTED] -----END RSA PRIVATE KEY-----"],
      [`OPENWEATHER_API_KEY=${fake("", 32)}`, "OPENWEATHER_API_KEY=[REDACTED]"],
      [`export DB_PASSWORD="${fake("", 14)}"`, 'export DB_PASSWORD="[REDACTED]"'],
      [`{"apiKey": "${fake("", 24)}", "model": "x"}`, '{"apiKey": "[REDACTED]", "model": "x"}'],
      [`  password: '${fake("", 10)}',`, "  password: '[REDACTED]',"],
    ];
    for (const [input, expected] of cases) expect(redactText(input)).toBe(expected);
  });

  it("leaves hashes, ids and code that only names a secret alone", () => {
    const safe = [
      "commit 3f9a1c2b7d8e4f60a1b2c3d4e5f60718293a4b5c",
      "sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "run 55005737-5774-44da-bce4-3b0ab37f8136",
      "const apiKey = process.env.OPENAI_API_KEY;",
      "OPENAI_API_KEY=$OPENAI_API_KEY",
      "  password: string;",
      '{"inputTokens": 1234, "maxTokens": 4096}',
      "import { tokenize } from './lexer';",
      "--secret-colour: #ff0000;",
      "npm install sk-react@2",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA",
    ];
    for (const text of safe) {
      expect(redactText(text)).toBe(text);
      expect(findSecret(text)).toBeNull();
    }
  });

  it("walks objects, masking values under secret-named keys", () => {
    const key = fake("nv" + "api-", 40);
    const out = redactValue({ input: { command: `curl -H "x-api-key: ${key}" https://x` }, headers: { authorization: "Basic abc123def456" }, apiKey: "short-but-secret", inputTokens: 1200, steps: [{ text: `token=${fake("", 20)}` }] });
    expect(JSON.stringify(out)).not.toContain(key);
    expect(out.headers.authorization).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
    expect(out.inputTokens).toBe(1200);
    expect(out.steps[0].text).toBe("token=[REDACTED]");
  });

  it("refuses a suggestion that would store a secret", () => {
    const r = normalizeSuggestion({ kind: "rule", name: "Deploy check", description: "Pings the API.", event: "before_finish", command: `curl -H "Authorization: Bearer ${fake("", 32)}" https://api.example.com/health`, evidence: "The deploy broke twice in run 3." });
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/secret/);
  });
});
