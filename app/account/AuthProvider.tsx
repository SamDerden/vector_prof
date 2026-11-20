"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMe,
  isAccountApiError,
  type AccountUser,
} from "@/lib/auth-api";

type AuthState = {
  /** true until the first /api/auth/me settles; avoids flashing the login form. */
  loading: boolean;
  authenticated: boolean;
  user: AccountUser | null;
  /** Set when /api/auth/me itself failed (network, 503, expired cookie). */
  error: string | null;
  refresh: () => Promise<void>;
  applyUser: (user: AccountUser | null) => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      if (!alive.current) return;
      setAuthenticated(Boolean(me.authenticated && me.user));
      setUser(me.user ?? null);
      setError(null);
    } catch (caught) {
      if (!alive.current) return;
      // 401 is an expected "not signed in" answer, not a failure to report.
      const status = isAccountApiError(caught) ? caught.status : 0;
      setAuthenticated(false);
      setUser(null);
      setError(status === 401 ? null : "Не удалось проверить состояние входа. Обнови страницу.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const applyUser = useCallback((next: AccountUser | null) => {
    setUser(next);
    setAuthenticated(Boolean(next));
  }, []);

  const value = useMemo<AuthState>(
    () => ({ loading, authenticated, user, error, refresh, applyUser }),
    [loading, authenticated, user, error, refresh, applyUser]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
