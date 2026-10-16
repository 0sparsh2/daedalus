"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { ApiError, api } from "@/lib/client/api";

export interface PreviewError {
  kind: string;
  message: string;
  stack?: string;
}

export interface SelectedElement {
  tag: string;
  text: string;
  path: string;
  classes: string;
}

/**
 * Live preview of the user's app: an iframe on the sandbox's public URL. The bridge script
 * in the app posts runtime errors and navigation here; errors are forwarded to the server
 * so the agent's check_preview can read them, and surfaced with a "fix it" action.
 * When a check sends a `checkId`, the frame reloads and reports `load` markers (an
 * acknowledgement, then the finished load) so the check reads errors from that load only.
 */
export function PreviewPanel({
  projectId,
  url,
  nonce,
  checkId,
  running,
  onUrl,
  onError,
  onSelect,
}: {
  projectId: string;
  url: string | null;
  nonce: number;
  checkId?: string;
  running: boolean;
  onUrl(u: string): void;
  onError(e: PreviewError): void;
  onSelect(el: SelectedElement): void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [path, setPath] = useState("/");
  const [device, setDevice] = useState<"desktop" | "phone">("desktop");
  const [reloads, setReloads] = useState(0);
  const [waking, setWaking] = useState(false);
  const [wakeError, setWakeError] = useState<string | null>(null);
  const generation = `${reloads}:${nonce}:${checkId ?? ""}`;
  const [errorState, setErrorState] = useState<{ gen: string; list: PreviewError[] }>({ gen: "", list: [] });
  const errors = errorState.gen === generation ? errorState.list : [];
  const frame = useRef<HTMLIFrameElement>(null);
  const seen = useRef(new Set<string>());

  const wake = useCallback(async () => {
    setWaking(true);
    setWakeError(null);
    try {
      const r = await api<{ url: string }>(`/api/projects/${projectId}/preview`, { method: "POST" });
      onUrl(r.url);
      setReloads((n) => n + 1);
    } catch (err) {
      setWakeError(err instanceof ApiError ? err.message : "Couldn't start the preview.");
    } finally {
      setWaking(false);
    }
  }, [projectId, onUrl]);


  // Tell the check a browser is watching; the new frame (keyed by generation) is loading now.
  useEffect(() => {
    if (!checkId || !url) return;
    void api(`/api/projects/${projectId}/preview-errors`, { method: "POST", json: { kind: "load", message: "ack", checkId } }).catch(() => {});
  }, [checkId, url, projectId]);

  useEffect(() => {
    if (!url) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    const onMessage = (e: MessageEvent) => {
      // Only the current frame: a replaced frame's late messages belong to an older load.
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { source?: string; type?: string; path?: string; kind?: string; message?: string; stack?: string; tag?: string; text?: string; classes?: string };
      if (d?.source !== "daedalus-preview") return;
      if (d.type === "selected") {
        setSelecting(false);
        onSelect({ tag: d.tag ?? "element", text: d.text ?? "", path: d.path ?? "", classes: d.classes ?? "" });
        return;
      }
      if (d.type === "select-cancelled") setSelecting(false);
      if (d.type === "navigate" && d.path) setPath(d.path);
      if (d.type === "ready" && d.path) setPath(d.path);
      if (d.type === "ready" && checkId) {
        void api(`/api/projects/${projectId}/preview-errors`, { method: "POST", json: { kind: "load", message: "loaded", url: d.path, checkId } }).catch(() => {});
      }
      if (d.type === "error" && d.message) {
        const key = `${generation}|${d.kind}:${d.message}`;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        const err = { kind: d.kind ?? "error", message: d.message, stack: d.stack };
        setErrorState((st) => ({ gen: generation, list: [...(st.gen === generation ? st.list : []), err].slice(-5) }));
        void api(`/api/projects/${projectId}/preview-errors`, { method: "POST", json: { ...err, url: d.path, checkId } }).catch(() => {});
        onError(err);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [url, projectId, onError, onSelect, generation, checkId]);

  const toggleSelect = () => {
    const next = !selecting;
    setSelecting(next);
    try {
      frame.current?.contentWindow?.postMessage({ source: "daedalus-host", type: "select-mode", on: next }, new URL(url ?? "").origin);
    } catch {
      setSelecting(false);
    }
  };

  if (!url) {
    return (
      <div className="empty">
        {running ? (
          <>
            <span className="spin" />
            <b>Setting up your sandbox</b>
            <span>The preview appears here as soon as the dev server is up.</span>
          </>
        ) : (
          <>
            <Icon name="eye" size={22} />
            <b>No preview yet</b>
            <span>Send a message to start building, or start the preview now.</span>
            <button className="btn" onClick={() => void wake()} disabled={waking}>
              {waking ? <span className="spin" /> : <Icon name="bolt" />} Start preview
            </button>
            {wakeError && <div className="error-text">{wakeError}</div>}
          </>
        )}
      </div>
    );
  }

  const src = `${url.replace(/\/$/, "")}${path}`;
  return (
    <div className="preview">
      <div className="urlbar">
        <button className="iconbtn" aria-label="Reload preview" title="Reload" onClick={() => setReloads((n) => n + 1)}>
          <Icon name="reload" />
        </button>
        <button
          className={`btn sm ${selecting ? "primary" : "ghost"}`}
          aria-pressed={selecting}
          onClick={toggleSelect}
          title="Click an element in your app to change it"
        >
          <Icon name="target" size={14} /> {selecting ? "Pick an element…" : "Select"}
        </button>
        <span className="url" title={src}>
          {path}
        </span>
        {errors.length > 0 && (
          <span className="pill bad" title={errors.map((e) => e.message).join("\n")}>
            <Icon name="alert" size={12} /> {errors.length} error{errors.length === 1 ? "" : "s"}
          </span>
        )}
        <div className="mode hide-sm" role="group" aria-label="Device">
          <button type="button" aria-pressed={device === "desktop"} onClick={() => setDevice("desktop")} aria-label="Desktop width">
            <Icon name="desktop" size={14} />
          </button>
          <button type="button" aria-pressed={device === "phone"} onClick={() => setDevice("phone")} aria-label="Phone width">
            <Icon name="phone" size={14} />
          </button>
        </div>
        <button className="iconbtn" aria-label="Wake the sandbox" title="Restart sandbox and dev server" onClick={() => void wake()} disabled={waking}>
          {waking ? <span className="spin" /> : <Icon name="bolt" />}
        </button>
        <a className="iconbtn" href={src} target="_blank" rel="noreferrer" aria-label="Open preview in a new tab" title="Open in a new tab">
          <Icon name="ext" />
        </a>
      </div>
      <div className={`frame-wrap ${device}`}>
        <iframe
          ref={frame}
          key={`${url}#${generation}`}
          src={src}
          title="App preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          allow="clipboard-write"
        />
      </div>
    </div>
  );
}
