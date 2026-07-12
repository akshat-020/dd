import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "../api/client";
import type { Role, User } from "../api/types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string, totpCode?: string) => Promise<void>;
  logout: () => void;
  hasRole: (...roles: Role[]) => boolean;
  // Owner/Warehouse always have scan-based putaway/pick access; Sales only
  // if individually granted (user.canScanPutaway) — mirrors the server's
  // canUseScanActions check.
  hasScanAccess: boolean;
  // Owner always has inward-entry access; Sales does by default (per-user
  // revocable) — mirrors the server's canLogInwardEntry check.
  hasInwardEntryAccess: boolean;
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

  const hasScanAccess = !!user && (user.role === "OWNER" || user.role === "WAREHOUSE" || (user.role === "SALES" && !!user.canScanPutaway));
  const hasInwardEntryAccess = !!user && (user.role === "OWNER" || (user.role === "SALES" && !!user.canLogInwardEntry));

  const value = useMemo(
    () => ({ user, loading, login, logout, hasRole, hasScanAccess, hasInwardEntryAccess }),
    [user, loading, login, logout, hasRole, hasScanAccess, hasInwardEntryAccess]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
