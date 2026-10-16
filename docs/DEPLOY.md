# Deploying Daedalus

Daedalus runs on **Vercel** (the Next.js app, Vercel Workflow for agent runs, Vercel Sandbox for users' apps) and **Supabase** (auth and Postgres). This is the full runbook. Steps marked *(owner)* need someone with the accounts to click through a browser; the rest can be run from a terminal.

## 1. Accounts and logins *(owner)*

```bash
cd daedalus
vercel login                 # opens a browser
pnpm supabase login          # opens a browser
```

## 2. Supabase project

```bash
# Create the project (or create it in the dashboard and skip this line)
pnpm supabase projects create daedalus --org-id <org-id> --db-password "$(openssl rand -base64 24)" --region us-east-1
pnpm supabase link --project-ref <project-ref>
pnpm supabase db push                         # applies supabase/migrations/*
pnpm supabase projects api-keys --project-ref <project-ref>   # publishable + secret keys
```

**Auth settings** (Dashboard → Authentication → URL configuration):

- **Site URL:** `https://<your-domain>`
- **Redirect URLs:** `https://<your-domain>/auth/callback` and `http://localhost:3000/auth/callback`

**Sign-in providers** *(owner)*:

- **Email:** on by default. For a demo, consider turning off "Confirm email" so reviewers can sign up instantly. The default SMTP sends only a few emails an hour.
- **GitHub:** create an OAuth App at github.com/settings/developers. Its callback is `https://<project-ref>.supabase.co/auth/v1/callback`. Paste the client id and secret into Supabase.
- **Google:** create an OAuth client in Google Cloud Console with the same callback URL, then paste the id and secret into Supabase.

## 3. GitHub OAuth app for "Connect GitHub" *(owner)*

This is a second OAuth App, separate from sign-in, with `repo` scope:

- **Homepage URL:** `https://<your-domain>`
- **Authorization callback URL:** `https://<your-domain>/api/github/callback`

## 4. Vercel project

```bash
vercel link --yes --project daedalus          # under the team that will host it
# Secrets: generate fresh ones for production
for kv in \
  "NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co" \
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>" \
  "SUPABASE_SECRET_KEY=<secret key>" \
  "CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -base64 32)" \
  "GATEWAY_TOKEN_SECRET=$(openssl rand -hex 32)" \
  "SANDBOX_PROVIDER=vercel" \
  "NEXT_PUBLIC_AUTH_PROVIDERS=github,google,email" \
  "NEXT_PUBLIC_APP_URL=https://<your-domain>" \
  "GITHUB_CLIENT_ID=<id>" "GITHUB_CLIENT_SECRET=<secret>" \
  "VERCEL_DEPLOY_TOKEN=<token with deploy scope>" "VERCEL_DEPLOY_TEAM_ID=<team id>"; do
  printf '%s' "${kv#*=}" | vercel env add "${kv%%=*}" production
done
vercel --prod
```

- **Keep the encryption key safe.** Changing `CREDENTIALS_ENCRYPTION_KEY` later makes stored keys undecryptable, and users would have to re-enter them.
- **Sandbox auth** uses OIDC automatically on Vercel; there's no token to set.
- **Optional, faster cold starts:** run `vercel env pull .env.local && node scripts/build-template-snapshot.mjs`, then set `VERCEL_TEMPLATE_SNAPSHOT_ID` to the printed id.
- **Preview deployments** are protected by Vercel Authentication. To run agents on them, enable *Protection Bypass for Automation*; `VERCEL_AUTOMATION_BYPASS_SECRET` is then forwarded on gateway calls.

## 5. Check production

1. Open `https://<your-domain>`, describe an app and press Send. You should see sign-in, then connect-a-model.
2. Connect an NVIDIA NIM key (free tier at build.nvidia.com) and build something small.
3. Open **Trace** to see the run tree. Use **Ship → Deploy** for a public URL and **Ship → Push** for GitHub.
4. In Vercel → Observability → Workflows, each run's steps and retries are visible.
