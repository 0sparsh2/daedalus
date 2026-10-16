"use client";
import type { User } from "@supabase/supabase-js";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { ApiError, api } from "@/lib/client/api";
import type { CredentialInfo } from "@/lib/client/session";
import { PROVIDERS, selectableProviders, type AnyProviderId } from "@/lib/llm/providers";
import { supabaseBrowser } from "@/lib/supabase/client";

export type AuthStep = "signin" | "model";

const OAUTH = (process.env.NEXT_PUBLIC_AUTH_PROVIDERS ?? "email").split(",").map((s) => s.trim());

const PROVIDER_BLURB: Record<AnyProviderId, string> = {
  nvidia: "Open models (Kimi, GLM, Nemotron) · free tier",
  anthropic: "Claude Sonnet, Opus, Haiku",
  openai: "GPT-6 and GPT-5 series",
  deepseek: "DeepSeek V4 Pro and Flash",
  mock: "Scripted model for tests",
};

export function AuthDialog(props: {
  step: AuthStep;
  reason?: string;
  provider?: AnyProviderId;
  signedIn: boolean;
  credentials: CredentialInfo[];
  onSignedIn(user: User): void | Promise<void>;
  onConnected(): void | Promise<void>;
  onClose(): void;
}) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button className="iconbtn close" onClick={props.onClose} aria-label="Close">
          <Icon name="x" />
        </button>
        <div className="steps" aria-label={`Step ${props.step === "signin" ? 1 : 2} of 2`}>
          <span className={`dot ${props.step === "signin" || props.signedIn ? "on" : ""}`} />
          <span className={`dot ${props.step === "model" ? "on" : ""}`} />
          <span>{props.step === "signin" ? "Sign in" : "Connect a model"}</span>
        </div>
        {props.step === "signin" ? (
          <SignIn titleId={titleId} reason={props.reason} onSignedIn={props.onSignedIn} />
        ) : (
          <ConnectModel titleId={titleId} initialProvider={props.provider} credentials={props.credentials} onConnected={props.onConnected} />
        )}
      </div>
    </div>
  );
}

function SignIn({ titleId, reason, onSignedIn }: { titleId: string; reason?: string; onSignedIn(user: User): void | Promise<void> }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => emailRef.current?.focus(), []);
  const sb = supabaseBrowser();
  const redirectTo = () => `${window.location.origin}/auth/callback?next=${encodeURIComponent(window.location.pathname)}`;

  async function oauth(provider: "github" | "google") {
    setBusy(provider);
    setError(null);
    const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: redirectTo() } });
    if (error) {
      setError(error.message);
      setBusy(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("email");
    setError(null);
    setNotice(null);
    try {
      if (mode === "signin") {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await onSignedIn(data.user);
      } else {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
        if (error) throw error;
        if (data.session && data.user) await onSignedIn(data.user);
        else setNotice("Check your inbox to confirm your email, then come back to this tab. Your idea is saved.");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function magicLink() {
    if (!email) {
      setError("Enter your email first.");
      emailRef.current?.focus();
      return;
    }
    setBusy("magic");
    setError(null);
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo() } });
    setBusy(null);
    if (error) setError(error.message);
    else setNotice(`We sent a sign-in link to ${email}. Open it in this browser; your idea is saved.`);
  }

  return (
    <>
      <div style={{ display: "grid", gap: 6 }}>
        <h2 id={titleId}>Sign in to start building</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {reason ?? "Your idea is saved. Sign in and Daedalus starts right away."}
        </p>
      </div>
      {(OAUTH.includes("github") || OAUTH.includes("google")) && (
        <>
          <div className="oauth">
            {OAUTH.includes("github") && (
              <button className="btn block" onClick={() => oauth("github")} disabled={Boolean(busy)}>
                {busy === "github" ? <span className="spin" /> : <Icon name="github" />} Continue with GitHub
              </button>
            )}
            {OAUTH.includes("google") && (
              <button className="btn block" onClick={() => oauth("google")} disabled={Boolean(busy)}>
                {busy === "google" ? <span className="spin" /> : <Icon name="google" />} Continue with Google
              </button>
            )}
          </div>
          <div className="divider">or use email</div>
        </>
      )}
      <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
        <label className="field">
          <span>Email</span>
          <input ref={emailRef} className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            className="input"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="error-text" role="alert">{error}</div>}
        {notice && <div className="banner info" role="status"><Icon name="mail" /> {notice}</div>}
        <button className="btn primary block" type="submit" disabled={Boolean(busy)}>
          {busy === "email" && <span className="spin" />} {mode === "signin" ? "Sign in" : "Create account"}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
          <button type="button" className="btn ghost sm" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
            {mode === "signin" ? "New here? Create an account" : "Have an account? Sign in"}
          </button>
          <button type="button" className="btn ghost sm" onClick={magicLink} disabled={Boolean(busy)}>
            {busy === "magic" ? <span className="spin" /> : <Icon name="mail" />} Email me a link
          </button>
        </div>
      </form>
    </>
  );
}

function ConnectModel({
  titleId,
  initialProvider,
  credentials,
  onConnected,
}: {
  titleId: string;
  initialProvider?: AnyProviderId;
  credentials: CredentialInfo[];
  onConnected(): void | Promise<void>;
}) {
  const [provider, setProvider] = useState<AnyProviderId>(initialProvider ?? "nvidia");
  const info = PROVIDERS[provider];
  const existing = credentials.find((c) => c.provider === provider && c.status === "valid");
  const [model, setModel] = useState(existing?.defaultModel ?? info.defaultModel);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const keyRef = useRef<HTMLInputElement>(null);

  function pickProvider(id: AnyProviderId) {
    const ex = credentials.find((c) => c.provider === id && c.status === "valid");
    setProvider(id);
    setModel(ex?.defaultModel ?? PROVIDERS[id].defaultModel);
    setKey("");
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (existing && !key) await api("/api/credentials", { method: "PATCH", json: { provider, model } });
      else {
        const r = await api<{ warning?: string }>("/api/credentials", { method: "POST", json: { provider, apiKey: key.trim(), model } });
        // The key works but the chosen model is busy: say so for a moment, then continue.
        if (r.warning) {
          setNotice(r.warning);
          await new Promise((res) => setTimeout(res, 2500));
        }
      }
      await onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save the key. Try again.");
      keyRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <h2 id={titleId}>Connect a model</h2>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          Daedalus runs on your own API key, so you control cost and which model builds your app.
        </p>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
        <legend className="field" style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Provider</legend>
        <div className="provider-grid">
          {selectableProviders().map((id) => {
            const c = credentials.find((x) => x.provider === id && x.status === "valid");
            return (
              <button type="button" key={id} className="provider-opt" aria-pressed={provider === id} onClick={() => pickProvider(id)}>
                <b>
                  {PROVIDERS[id].label} {c && <Icon name="check" size={14} className="ok" />}
                </b>
                <span>{c ? `Connected · ••••${c.last4}` : PROVIDER_BLURB[id]}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <label className="field">
        <span>Model</span>
        <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
          {info.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.fast ? " · fast" : ""}
              {m.id === info.defaultModel ? " · recommended" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          {info.label} API key {existing && <span className="faint" style={{ fontWeight: 400 }}>(leave empty to keep ••••{existing.last4})</span>}
        </span>
        <div className="keyrow">
          <input
            ref={keyRef}
            className="input"
            type={show ? "text" : "password"}
            autoComplete="off"
            spellCheck={false}
            placeholder={info.keyPlaceholder}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            required={!existing}
            aria-describedby="key-help"
          />
          <button type="button" className="btn" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide key" : "Show key"}>
            <Icon name="eye" />
          </button>
        </div>
        <span className="hint" id="key-help">
          No key yet?{" "}
          <a href={info.keyUrl} target="_blank" rel="noreferrer">
            Get a {info.label} key <Icon name="ext" size={12} />
          </a>
        </span>
      </label>
      <div className="secure-note">
        <Icon name="shield" />
        <span>We check the key with {info.label}, encrypt it (AES-256-GCM) and never send it to your browser or your app&apos;s sandbox. Only the Daedalus gateway uses it, per run.</span>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
      {notice && <div className="banner info" role="status"><Icon name="info" /> {notice}</div>}
      <button className="btn primary block" type="submit" disabled={busy || (!existing && key.trim().length < 10)}>
        {busy && <span className="spin" />} {existing && !key ? `Use ${info.label}` : "Check key and continue"}
      </button>
    </form>
  );
}
