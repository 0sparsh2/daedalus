import "server-only";

/** Server environment, read lazily so builds don't need every secret present. */
function required(name: string, ...fallbacks: string[]): string {
  for (const n of [name, ...fallbacks]) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Missing environment variable ${name}`);
}

export const env = {
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabasePublishableKey: () => required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseSecretKey: () => required("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
  encryptionKey: () => required("CREDENTIALS_ENCRYPTION_KEY"),
  sandboxProvider: () => (process.env.SANDBOX_PROVIDER ?? (process.env.VERCEL ? "vercel" : "docker")) as "vercel" | "docker",
  /** Public base URL of this deployment; the gateway URL handed to agents is derived from it. */
  appUrl: () =>
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000"),
  tavilyKey: () => process.env.TAVILY_API_KEY,
  githubClientId: () => process.env.GITHUB_CLIENT_ID,
  githubClientSecret: () => process.env.GITHUB_CLIENT_SECRET,
  vercelDeployToken: () => process.env.VERCEL_DEPLOY_TOKEN ?? process.env.VERCEL_TOKEN,
  vercelDeployTeamId: () => process.env.VERCEL_DEPLOY_TEAM_ID ?? process.env.VERCEL_TEAM_ID,
};
