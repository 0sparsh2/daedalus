"use client";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AuthDialog, type AuthStep } from "@/components/auth-dialog";
import type { AnyProviderId } from "@/lib/llm/providers";
import { supabaseBrowser } from "@/lib/supabase/client";
import { api } from "./api";

export interface CredentialInfo {
  provider: AnyProviderId;
  last4: string;
  defaultModel: string;
  status: "valid" | "invalid";
  updatedAt: string;
}

export interface ActiveModel {
  provider: AnyProviderId;
  model: string;
}

interface SessionValue {
  user: User | null;
  credentials: CredentialInfo[];
  active: ActiveModel | null;
  loading: boolean;
  refresh(): Promise<void>;
  /**
   * Resolves once the user is signed in and has a usable model key, opening the sign-in /
   * connect-a-model dialog if needed. Resolves false if the user closes the dialog.
   */
  ensureReady(opts?: { reason?: string; provider?: AnyProviderId }): Promise<boolean>;
  openKeys(provider?: AnyProviderId): Promise<boolean>;
  setActive(model: ActiveModel): Promise<void>;
  signOut(): Promise<void>;
}

interface Keys {
  userId: string | null;
  credentials: CredentialInfo[];
  active: ActiveModel | null;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside SessionProvider");
  return v;
}

async function fetchKeys(userId: string): Promise<Keys> {
  try {
    const r = await api<{ credentials: CredentialInfo[]; active: ActiveModel | null }>("/api/credentials");
    return { userId, credentials: r.credentials, active: r.active };
  } catch {
    return { userId, credentials: [], active: null };
  }
}

export function SessionProvider({ initialUser, children }: { initialUser: User | null; children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(initialUser);
  const [keys, setKeys] = useState<Keys>({ userId: null, credentials: [], active: null });
  const [dialog, setDialog] = useState<{ step: AuthStep; reason?: string; provider?: AnyProviderId } | null>(null);
  const waiter = useRef<((ok: boolean) => void) | null>(null);

  // Keys belong to a user; when the user changes, stale keys simply stop matching.
  const mine = Boolean(user) && keys.userId === user?.id;
  const credentials = useMemo(() => (mine ? keys.credentials : []), [mine, keys.credentials]);
  const active = mine ? keys.active : null;
  const loading = Boolean(user) && !mine;

  useEffect(() => {
    const { data } = supabaseBrowser().auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
      setUser(session?.user ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void fetchKeys(user.id).then((k) => {
      if (!cancelled) setKeys(k);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const refresh = useCallback(async () => {
    if (user) setKeys(await fetchKeys(user.id));
  }, [user]);

  const finish = useCallback((ok: boolean) => {
    setDialog(null);
    waiter.current?.(ok);
    waiter.current = null;
  }, []);

  const open = useCallback((step: AuthStep, reason?: string, provider?: AnyProviderId) => {
    return new Promise<boolean>((resolve) => {
      waiter.current?.(false);
      waiter.current = resolve;
      setDialog({ step, reason, provider });
    });
  }, []);

  const ensureReady = useCallback(
    (opts: { reason?: string; provider?: AnyProviderId } = {}) => {
      const hasKey = credentials.some((c) => c.status === "valid");
      if (user && hasKey && !opts.provider) return Promise.resolve(true);
      return open(user ? "model" : "signin", opts.reason, opts.provider);
    },
    [credentials, user, open],
  );

  const openKeys = useCallback((provider?: AnyProviderId) => open(user ? "model" : "signin", undefined, provider), [user, open]);

  const setActive = useCallback(
    async (m: ActiveModel) => {
      await api("/api/credentials", { method: "PATCH", json: m });
      setKeys((k) => ({ ...k, active: m }));
    },
    [],
  );

  const signOut = useCallback(async () => {
    await supabaseBrowser().auth.signOut();
    setUser(null);
    router.push("/");
    router.refresh();
  }, [router]);

  const value = useMemo<SessionValue>(
    () => ({ user, credentials, active, loading, refresh, ensureReady, openKeys, setActive, signOut }),
    [user, credentials, active, loading, refresh, ensureReady, openKeys, setActive, signOut],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {dialog && (
        <AuthDialog
          step={dialog.step}
          reason={dialog.reason}
          provider={dialog.provider}
          signedIn={Boolean(user)}
          credentials={credentials}
          onSignedIn={async (u) => {
            setUser(u);
            const k = await fetchKeys(u.id);
            setKeys(k);
            if (k.credentials.some((c) => c.status === "valid") && !dialog.provider) finish(true);
            else setDialog((d) => (d ? { ...d, step: "model" } : d));
          }}
          onConnected={async () => {
            if (user) setKeys(await fetchKeys(user.id));
            finish(true);
          }}
          onClose={() => finish(false)}
        />
      )}
    </Ctx.Provider>
  );
}
