import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ToolError, truncateMiddle } from "../runtime";
import type { ToolOutput } from "../scope";

/**
 * Web access for the research sub-agent. Fetches run on the Daedalus server, not in the
 * user's sandbox, so they are guarded against SSRF: http(s) only, public addresses only
 * (checked after DNS resolution and on every redirect), bounded size and time.
 */

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;

function isPrivate(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v === "::" || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  );
}

async function assertPublic(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError(`Only http(s) URLs can be fetched (got ${url.protocol}).`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new ToolError("Local addresses can't be fetched.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) throw new ToolError(`Couldn't resolve ${host}.`);
  if (addrs.some((a) => isPrivate(a.address))) throw new ToolError("Private network addresses can't be fetched.");
}

async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(raw);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    return res;
  }
  throw new ToolError("Too many redirects.");
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Readable text from HTML: drops scripts, styles and chrome, keeps headings, links and code. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\n\`\`\`\n${c.replace(/<[^>]+>/g, "")}\n\`\`\`\n`)
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${c.replace(/<[^>]+>/g, "")}\``)
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, "").trim()} (${href})`)
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export async function webFetch(input: { url: string; max_chars?: number }): Promise<ToolOutput> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new ToolError(`Not a valid URL: ${input.url}`);
  }
  const res = await safeFetch(url.toString(), { headers: { "user-agent": "DaedalusResearch/1.0 (+https://daedalus.dev)", accept: "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5" } });
  if (!res.ok) throw new ToolError(`${url.host} returned HTTP ${res.status}.`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text|json|xml|markdown/.test(type)) throw new ToolError(`Unsupported content type ${type}.`);
  const body = await readCapped(res);
  const text = /html/.test(type) ? htmlToText(body) : body;
  const max = Math.min(input.max_chars ?? 12_000, 30_000);
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return { ok: true, text: `${title ? `# ${title}\n` : ""}Source: ${url}\n\n${truncateMiddle(text, max)}`, url: url.toString(), title };
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Tavily when a key is configured; otherwise DuckDuckGo's HTML endpoint (no key needed). */
export async function webSearch(input: { query: string; max_results?: number }): Promise<ToolOutput & { hits: SearchHit[] }> {
  const n = Math.min(input.max_results ?? 6, 10);
  let hits: SearchHit[] = [];
  const tavily = process.env.TAVILY_API_KEY;
  if (tavily) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tavily}` },
      body: JSON.stringify({ query: input.query, max_results: n, search_depth: "basic" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const j = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> };
      hits = (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content.slice(0, 400) }));
    }
  }
  if (hits.length === 0) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; DaedalusResearch/1.0)" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const html = await res.text();
    const blocks = html.split('class="result__body"').slice(1);
    for (const b of blocks) {
      const link = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!link) continue;
      let href = link[1];
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      if (href.startsWith("//")) href = `https:${href}`;
      const snippet = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
      hits.push({ title: htmlToText(link[2]), url: href, snippet: htmlToText(snippet).slice(0, 400) });
      if (hits.length >= n) break;
    }
  }
  if (hits.length === 0) return { ok: false, text: `No results for "${input.query}". Try different keywords.`, hits };
  return {
    ok: true,
    text: hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"),
    hits,
  };
}
