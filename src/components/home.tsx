"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer, type RunMode } from "@/components/composer";
import { Brand, Icon } from "@/components/icons";
import { UserMenu } from "@/components/user-menu";
import { ApiError, api, timeAgo } from "@/lib/client/api";
import { useSession } from "@/lib/client/session";

const EXAMPLES = [
  "A booking app for a small clinic: patients pick a service and a time slot",
  "A habit tracker with streaks and a weekly heatmap",
  "A kanban board for my team with drag and drop",
  "A landing page for a coffee roastery with a menu and opening hours",
];

const PENDING = "daedalus:pending";

interface ProjectCard {
  id: string;
  name: string;
  status: string;
  updated_at: string;
  description: string | null;
}

export function HomeClient({ projects }: { projects: ProjectCard[] }) {
  const router = useRouter();
  const { user, ensureReady, loading } = useSession();
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<RunMode>("plan");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const resumed = useRef(false);

  const start = useCallback(
    async (text: string, m: RunMode) => {
      setError(null);
      // Keep the idea safe across the sign-in redirect.
      try {
        localStorage.setItem(PENDING, JSON.stringify({ text, mode: m, at: Date.now() }));
      } catch {}
      const ready = await ensureReady({ reason: "Your idea is saved. Sign in and Daedalus will start building it." });
      if (!ready) return;
      setBusy(true);
      try {
        const { project } = await api<{ project: { id: string } }>("/api/projects", { method: "POST", json: { prompt: text } });
        sessionStorage.setItem(`daedalus:autostart:${project.id}`, JSON.stringify({ text }));
        try {
          localStorage.removeItem(PENDING);
        } catch {}
        router.push(`/p/${project.id}?mode=${m}`);
      } catch (err) {
        setBusy(false);
        setError(err instanceof ApiError ? err.message : "Couldn't start the project. Try again.");
      }
    },
    [ensureReady, router],
  );

  const importRepo = useCallback(
    async (url: string) => {
      const ready = await ensureReady({ reason: "Sign in and connect a model to import a project." });
      if (!ready) return "cancelled";
      const r = await api<{ project: { id: string } }>("/api/projects/import", { method: "POST", json: { url } });
      sessionStorage.setItem(
        `daedalus:autostart:${r.project.id}`,
        JSON.stringify({
          text: "I just imported this project. Explore it and give me a short overview: what it does, how it's organised, how it runs, and the first three things you'd improve. Don't change any files yet.",
        }),
      );
      router.push(`/p/${r.project.id}?mode=build`);
      return "ok";
    },
    [ensureReady, router],
  );

  // Returning from an OAuth or magic-link sign-in: pick the saved idea back up.
  useEffect(() => {
    if (resumed.current || loading) return;
    let pending: { text: string; mode: RunMode; at: number } | null = null;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING) ?? "null");
    } catch {}
    if (!pending || Date.now() - pending.at > 60 * 60_000) return;
    resumed.current = true;
    setPrompt(pending.text);
    setMode(pending.mode);
    if (user) void start(pending.text, pending.mode);
  }, [user, loading, start]);

  return (
    <div className="home">
      <header className="nav">
        <Brand />
        <span className="spacer" />
        {user ? (
          <UserMenu />
        ) : (
          <button className="btn ghost" onClick={() => void ensureReady({ reason: "Sign in to see your projects." })}>
            Sign in
          </button>
        )}
      </header>
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div style={{ display: "grid", gap: 10 }}>
            <h1 id="hero-title">What do you want to build?</h1>
            <p className="sub">
              Describe it in your own words. Daedalus plans it with you, builds it in a live sandbox, checks its own work, and keeps every
              version.
            </p>
          </div>
          <Composer value={prompt} onChange={setPrompt} onSubmit={() => void start(prompt.trim(), mode)} mode={mode} onModeChange={setMode} autoFocus disabled={busy} />
          {error && <div className="error-text" role="alert">{error}</div>}
          {busy && (
            <div className="status-line" role="status">
              <span className="spin" /> Creating your project…
            </div>
          )}
          <div className="examples" aria-label="Start from">
            <button type="button" className="chip" onClick={() => setImportOpen(true)}>
              <Icon name="github" size={13} /> Import from GitHub
            </button>
          </div>
          <div className="examples" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="chip" onClick={() => setPrompt(ex)}>
                <Icon name="sparkle" size={13} /> {ex.length > 52 ? `${ex.slice(0, 50)}…` : ex}
              </button>
            ))}
          </div>
        </section>
        {user && projects.length > 0 && (
          <section className="recent" aria-labelledby="recent-title">
            <h2 id="recent-title" className="label">
              Your projects
            </h2>
            <div className="proj-grid">
              {projects.map((p) => (
                <a key={p.id} href={`/p/${p.id}`} className="proj-card">
                  <b>{p.name}</b>
                  <span className="muted" style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.description ?? "No description"}
                  </span>
                  <span className="faint" style={{ fontSize: 12 }}>
                    {p.status === "building" ? "Building…" : "Edited"} {timeAgo(p.updated_at)}
                  </span>
                </a>
              ))}
            </div>
          </section>
        )}
      </main>
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImport={importRepo} />}
      <footer className="foot">
        <span>Your keys, your models: Anthropic, OpenAI, DeepSeek or NVIDIA NIM.</span>
        <span>Every change is saved as a version you can restore.</span>
        <a href="/prototype.html" target="_blank" rel="noreferrer">
          Explore the full product design (agents, automations, customize) <Icon name="ext" size={12} />
        </a>
      </footer>
    </div>
  );
}

function ImportDialog({ onClose, onImport }: { onClose(): void; onImport(url: string): Promise<string> }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await onImport(url);
            if (r === "cancelled") setBusy(false);
          } catch (err) {
            setBusy(false);
            setError(err instanceof ApiError ? err.message : "Import failed. Check the URL and try again.");
          }
        }}
      >
        <button type="button" className="iconbtn close" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
        <h2 id="import-title">Import a project from GitHub</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Daedalus copies the repository into its own sandbox, installs it, starts its dev server and maps the codebase for you. Private
          repos need GitHub connected; if you can push to the repo, Ship → Push sends changes back to it.
        </p>
        <label className="field">
          <span>Repository URL</span>
          <input className="input" autoFocus placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        {error && <div className="error-text" role="alert">{error}</div>}
        <button className="btn primary block" type="submit" disabled={busy || url.trim().length < 3}>
          {busy && <span className="spin" />} Import and explore
        </button>
      </form>
    </div>
  );
}
