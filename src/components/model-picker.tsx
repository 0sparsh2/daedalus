"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { useSession } from "@/lib/client/session";
import { PROVIDERS, getModelInfo, selectableProviders } from "@/lib/llm/providers";

/**
 * Model picker. Every provider is listed so people can see what Daedalus supports; providers
 * without a key are locked and offer "Add key", which opens the connect-a-model dialog.
 */
export function ModelPicker({ align = "left", compact = false }: { align?: "left" | "right"; compact?: boolean }) {
  const { user, credentials, active, loading, setActive, openKeys, ensureReady } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = active ? getModelInfo(active.provider, active.model).label : user ? "Connect a model" : "Choose a model";

  if (user && loading) {
    return (
      <span className="chip" aria-busy="true">
        <span className="spin" /> Model
      </span>
    );
  }

  if (!user || credentials.length === 0) {
    return (
      <button type="button" className="chip" onClick={() => void ensureReady({ reason: "Pick the model Daedalus should build with." })}>
        <Icon name="key" size={14} /> {label}
      </button>
    );
  }

  return (
    <div className="menu-wrap" ref={ref} style={{ position: "relative" }}>
      <button type="button" className="chip" aria-expanded={open} aria-label={`Model: ${label}`} onClick={() => setOpen((o) => !o)}>
        <Icon name="sparkle" size={14} />
        {!compact && active && <span className="faint">{PROVIDERS[active.provider].label} ·</span>}
        <span className="chip-label">{label}</span>
        <Icon name="chev" size={14} />
      </button>
      {open && (
        <div className="pop picker" role="group" aria-label="Choose a model" style={{ [align === "left" ? "left" : "right"]: 0, top: "auto", bottom: "calc(100% + 6px)", width: 320 } as React.CSSProperties} data-placement="up">
          {selectableProviders().map((pid) => {
            const cred = credentials.find((c) => c.provider === pid && c.status === "valid");
            const p = PROVIDERS[pid];
            return (
              <div key={pid} role="group" aria-label={p.label}>
                <div className="group label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {p.label}
                  {cred ? <span className="pill ok" style={{ marginLeft: "auto" }}>••••{cred.last4}</span> : <Icon name="lock" size={13} />}
                </div>
                {cred ? (
                  p.models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={active?.provider === pid && active.model === m.id}
                      className="opt"
                      onClick={async () => {
                        setOpen(false);
                        await setActive({ provider: pid, model: m.id });
                      }}
                    >
                      {m.label}
                      <span className="meta">{m.fast ? "fast" : m.reasoning ? "reasoning" : ""}</span>
                    </button>
                  ))
                ) : (
                  <div className="lockrow">
                    <span style={{ flex: 1 }}>{p.models.slice(0, 3).map((m) => m.label).join(", ")}…</span>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setOpen(false);
                        void openKeys(pid);
                      }}
                    >
                      <Icon name="key" size={13} /> Add key
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
