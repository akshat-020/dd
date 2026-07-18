import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "../api/client";
import type { Role, User } from "../api/types";
import type { PermissionKey } from "../lib/permissions";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string, totpCode?: string) => Promise<void>;
  logout: () => void;
  // Still useful for the handful of things that stay structurally
  // role-based rather than an individually-grantable permission (Owner-only
  // admin screens, etc.) — see the access-control model for which is which.
  hasRole: (...roles: Role[]) => boolean;
  // The general-purpose check for anything in the permission catalogue.
  // Membership in user.permissions — Owner's array already contains every
  // key, so there's no special-casing needed here.
  hasPermission: (permission: PermissionKey) => boolean;
  // True if any of the given permissions is granted — for the few spots
  // where either of two permissions is sufficient (mirrors the server's
  // requireAnyPermission).
  hasAnyPermission: (...permissions: PermissionKey[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMe();
    const onUnauthorized = () => setUser(null);
    window.addEventListener("oms:unauthorized", onUnauthorized);
    return () => window.removeEventListener("oms:unauthorized", onUnauthorized);
  }, [loadMe]);

  const login = useCallback(async (email: string, password: string, totpCode?: string) => {
    const res = await api.post<{ token: string; user: User }>("/auth/login", { email, password, totpCode });
    setToken(res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    // Best-effort — revokes the server-side session so the token can't be
    // reused even if something captured it, but don't block clearing the
    // local session on the request succeeding.
    api.post("/auth/logout").catch(() => {});
    setToken(null);
    setUser(null);
  }, []);

  const hasRole = useCallback((...roles: Role[]) => !!user && roles.includes(user.role), [user]);
  const hasPermission = useCallback((permission: PermissionKey) => !!user && user.permissions.includes(permission), [user]);
  const hasAnyPermission = useCallback(
    (...permissions: PermissionKey[]) => !!user && permissions.some((p) => user.permissions.includes(p)),
    [user]
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, hasRole, hasPermission, hasAnyPermission }),
    [user, loading, login, logout, hasRole, hasPermission, hasAnyPermission]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
