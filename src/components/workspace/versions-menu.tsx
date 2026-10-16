"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { ApiError, api, timeAgo } from "@/lib/client/api";

export interface Checkpoint {
  id: string;
  sha: string;
  message: string;
  files_changed: number;
  created_at: string;
}

/** Every run that changed files is a git commit in the sandbox; restoring is a new commit too. */
export function VersionsMenu({ projectId, checkpoints, disabled, onRestored }: { projectId: string; checkpoints: Checkpoint[]; disabled: boolean; onRestored(): void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function restore(sha: string) {
    setBusy(sha);
    setError(null);
    try {
      await api(`/api/projects/${projectId}/restore`, { method: "POST", json: { sha } });
      setOpen(false);
      onRestored();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Restore failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="menu-wrap" ref={ref}>
      <button className="btn ghost" aria-expanded={open} aria-label={`Versions (${checkpoints.length})`} onClick={() => setOpen((o) => !o)} title="Versions">
        <Icon name="history" /> <span className="hide-sm">Versions</span>
        {checkpoints.length > 0 && <span className="pill">{checkpoints.length}</span>}
      </button>
      {open && (
        <div className="pop" role="group" aria-label="Saved versions" style={{ width: "min(360px, calc(100vw - 32px))" }}>
          <div className="group label">Saved versions</div>
          {checkpoints.length === 0 && <div className="lockrow">Each run that changes your app saves a version here.</div>}
          <div className="versions">
            {checkpoints.map((c, i) => (
              <div key={c.id} className="version">
                <div style={{ minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.message}</div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    <span className="mono">{c.sha.slice(0, 7)}</span> · {timeAgo(c.created_at)}
                    {i === 0 && " · current"}
                  </div>
                </div>
                {i > 0 && (
                  <button className="btn sm" disabled={disabled || Boolean(busy)} onClick={() => void restore(c.sha)}>
                    {busy === c.sha ? <span className="spin" /> : "Restore"}
                  </button>
                )}
              </div>
            ))}
          </div>
          {error && <div className="error-text" style={{ margin: 6 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
