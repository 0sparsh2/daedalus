import { afterEach, describe, expect, it, vi } from "vitest";
import { webSearch } from "@/lib/agent/tools/web";

// The search chain: free engines first (SearXNG), then keyed APIs (Tavily, Brave), then
// DuckDuckGo, then the npm and GitHub indexes. The network is stubbed by URL.
type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const stub = (routes: Record<string, Route>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (!hit) throw new Error(`unexpected fetch ${url}`);
      return hit[1](url, init);
    }),
  );
const json = (o: unknown) => Response.json(o);
const blocked = () => new Response("<html>anomaly</html>", { status: 202 });

describe("web search chain", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses a free SearXNG instance first when one is configured", async () => {
    vi.stubEnv("SEARXNG_URL", "http://127.0.0.1:8888/");
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    stub({
      "http://127.0.0.1:8888/search?q=open-meteo&format=json": () =>
        json({ results: [{ title: "Geocoding API", url: "https://open-meteo.com/en/docs/geocoding-api", content: "Search locations by name" }] }),
    });
    const r = await webSearch({ query: "open-meteo" });
    expect(r).toMatchObject({ ok: true, engine: "SearXNG" });
    expect(r.hits[0].url).toBe("https://open-meteo.com/en/docs/geocoding-api");
  });

  it("falls through to Tavily when SearXNG is down", async () => {
    vi.stubEnv("SEARXNG_URL", "http://127.0.0.1:8888");
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    stub({
      "http://127.0.0.1:8888": () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED");
      },
      "https://api.tavily.com/search": (_u, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tvly-test");
        return json({ results: [{ title: "Open-Meteo docs", url: "https://open-meteo.com/en/docs", content: "Forecast API" }] });
      },
    });
    expect(await webSearch({ query: "open-meteo" })).toMatchObject({ ok: true, engine: "Tavily" });
  });

  it("ends at the npm and GitHub indexes, and says so, when web engines give nothing", async () => {
    vi.stubEnv("SEARXNG_URL", "");
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    stub({
      "https://html.duckduckgo.com": blocked,
      "https://registry.npmjs.org": () => json({ objects: [{ package: { name: "openmeteo", description: "Open-Meteo Weather API", links: { homepage: "https://github.com/open-meteo/typescript#readme" } } }] }),
      "https://api.github.com": () => json({ items: [] }),
    });
    const r = await webSearch({ query: "open-meteo" });
    expect(r).toMatchObject({ ok: true, engine: "npm + GitHub" });
    expect(r.text).toMatch(/package and repository matches/);
  });

  it("tells the agent to go to the docs when nothing answers", async () => {
    vi.stubEnv("SEARXNG_URL", "");
    vi.stubEnv("TAVILY_API_KEY", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    stub({ "https://html.duckduckgo.com": blocked, "https://registry.npmjs.org": () => json({ objects: [] }), "https://api.github.com": () => json({ items: [] }) });
    const r = await webSearch({ query: "zzzz" });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/fetch the official documentation directly/);
  });
});
