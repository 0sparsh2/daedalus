"use client";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { useSession } from "@/lib/client/session";
import { PROVIDERS } from "@/lib/llm/providers";

export function UserMenu() {
  const { user, credentials, openKeys, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  if (!user) return null;
  const initial = (user.email ?? "?")[0].toUpperCase();
  return (
    <div className="menu-wrap" ref={ref}>
      <button className="iconbtn" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label="Account menu" style={{ borderRadius: "50%", background: "var(--sunk)", color: "var(--text)", fontWeight: 600 }}>
        {initial}
      </button>
      {open && (
        <div className="pop" role="group" aria-label="Account" style={{ right: 0, top: "calc(100% + 6px)", width: 280 }}>
          <div className="group" style={{ fontSize: 13 }}>
            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{user.email}</div>
          </div>
          <div className="group label">Model keys</div>
          {credentials.length === 0 && <div className="lockrow">No keys yet</div>}
          {credentials.map((c) => (
            <div key={c.provider} className="lockrow">
              <span style={{ flex: 1 }}>{PROVIDERS[c.provider].label}</span>
              <span className={`pill ${c.status === "valid" ? "ok" : "bad"}`}>{c.status === "valid" ? `••••${c.last4}` : "invalid"}</span>
            </div>
          ))}
          <button className="opt" onClick={() => { setOpen(false); void openKeys(); }}>
            <Icon name="key" /> Manage model keys
          </button>
          <a className="opt" href="/prototype.html" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <Icon name="sparkle" /> Product design tour
          </a>
          <button className="opt" onClick={() => void signOut()}>
            <Icon name="logout" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
