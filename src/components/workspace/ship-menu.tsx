"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { ApiError, api } from "@/lib/client/api";

interface ShipState {
  github: { connected: boolean; login?: string; repo?: string | null; configured: boolean };
  deploy: { configured: boolean; url?: string | null; status?: string | null };
}

/** Push to GitHub and deploy to a live URL. */
export function ShipMenu({ projectId, disabled, initialRepo, initialDeployUrl }: { projectId: string; disabled: boolean; initialRepo: string | null; initialDeployUrl: string | null }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ShipState | null>(null);
  const [busy, setBusy] = useState<"github" | "deploy" | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; href?: string } | null>(null);
  const [repo, setRepo] = useState(initialRepo);
  const [deployUrl, setDeployUrl] = useState(initialDeployUrl);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api<ShipState>(`/api/projects/${projectId}/ship`).then(setState).catch(() => setState(null));
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, projectId]);

  async function push() {
    setBusy("github");
    setMessage(null);
    try {
      const r = await api<{ repo: string; url: string; sha: string }>(`/api/projects/${projectId}/github`, { method: "POST" });
      setRepo(r.repo);
      setMessage({ kind: "ok", text: `Pushed to ${r.repo}`, href: r.url });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Push failed" });
    } finally {
      setBusy(null);
    }
  }

  async function deploy() {
    setBusy("deploy");
    setMessage(null);
    try {
      const r = await api<{ url: string }>(`/api/projects/${projectId}/deploy`, { method: "POST" });
      setDeployUrl(r.url);
      setMessage({ kind: "ok", text: "Your app is live", href: r.url });
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof ApiError ? e.message : "Deploy failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn primary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="rocket" /> <span className="hide-sm">Ship</span>
      </button>
      {open && (
        <div className="pop" role="menu" style={{ width: 340, padding: 12, display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <div className="label">Deploy</div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Builds your app and publishes it to a public URL on Vercel.
            </p>
            {deployUrl && (
              <a href={deployUrl} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
                {deployUrl} <Icon name="ext" size={12} />
              </a>
            )}
            <button className="btn primary" disabled={disabled || busy !== null || state?.deploy.configured === false} onClick={() => void deploy()}>
              {busy === "deploy" ? <span className="spin" /> : <Icon name="rocket" />} {deployUrl ? "Deploy again" : "Deploy"}
            </button>
            {state?.deploy.configured === false && <span className="hint">Deploys aren&apos;t configured on this server yet.</span>}
          </div>
          <div style={{ display: "grid", gap: 6, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
            <div className="label">GitHub</div>
            {repo && (
              <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12.5 }}>
                {repo} <Icon name="ext" size={12} />
              </a>
            )}
            {state && !state.github.configured ? (
              <span className="hint">GitHub isn&apos;t configured on this server yet.</span>
            ) : state && !state.github.connected ? (
              <a className="btn" href={`/api/github/connect?next=${encodeURIComponent(`/p/${projectId}`)}`}>
                <Icon name="github" /> Connect GitHub
              </a>
            ) : (
              <button className="btn" disabled={disabled || busy !== null || !state} onClick={() => void push()}>
                {busy === "github" ? <span className="spin" /> : <Icon name="github" />} {repo ? "Push changes" : "Create repo and push"}
              </button>
            )}
            {state?.github.login && <span className="hint">Connected as @{state.github.login}</span>}
          </div>
          {message && (
            <div className={message.kind === "ok" ? "banner info" : "error-text"} role="status">
              {message.text}{" "}
              {message.href && (
                <a href={message.href} target="_blank" rel="noreferrer">
                  Open <Icon name="ext" size={12} />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
