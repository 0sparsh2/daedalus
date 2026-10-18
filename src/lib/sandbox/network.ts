/**
 * What a project's sandbox may reach on the internet. The app's own API calls run in the
 * user's browser (the preview), not in the sandbox, so the sandbox needs little: the npm
 * registry to install packages and GitHub for git dependencies and release downloads. A project
 * whose server-side code calls an API adds that domain itself.
 *
 * Enforced by Vercel Sandbox's network policy (its firewall). Local Docker sandboxes aren't
 * restricted: an internal Docker network blocks egress but also the published preview port.
 * Pure: shared by the provider, the API and the UI.
 */

export const DEFAULT_SANDBOX_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
] as const;

export const MAX_EXTRA_DOMAINS = 30;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A domain the user may add: a hostname, or `*.` plus one with at least two labels. Returns null if invalid. */
export function normalizeDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  const wildcard = d.startsWith("*.");
  const host = wildcard ? d.slice(2) : d;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null; // an IP address, not a domain
  if (wildcard && labels.length < 2) return null;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
  return wildcard ? `*.${host}` : host;
}

export function allowedDomains(extra: readonly string[] = []): string[] {
  return [...new Set([...DEFAULT_SANDBOX_DOMAINS, ...extra.map(normalizeDomain).filter((d): d is string => Boolean(d))])];
}

/** The Vercel Sandbox network policy: only these domains; everything else is denied. */
export function sandboxNetworkPolicy(extra: readonly string[] = []): { allow: string[] } | "allow-all" {
  if (process.env.SANDBOX_NETWORK === "open") return "allow-all";
  return { allow: allowedDomains(extra) };
}
