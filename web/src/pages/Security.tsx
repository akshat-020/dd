import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { Session } from "../api/types";

export default function Security() {
  const { user, hasRole } = useAuth();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Security</h1>
      <TwoFactorSection enabled={!!user?.totpEnabled} />
      <SessionsSection />
      {hasRole("OWNER") && <AllSessionsSection />}
      {hasRole("OWNER") && <AuditIntegritySection />}
    </div>
  );
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const [enrolling, setEnrolling] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function startEnroll() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.post<{ secret: string; otpauthUrl: string }>("/auth/2fa/enroll");
      setSecret(res.secret);
      setQrDataUrl(await QRCode.toDataURL(res.otpauthUrl));
      setEnrolling(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to start enrollment");
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/2fa/confirm", { code });
      setNotice("Two-factor authentication enabled.");
      setEnrolling(false);
      setCode("");
      window.location.reload(); // refresh /me so the enabled state reflects everywhere
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post("/auth/2fa/disable", { password: disablePassword });
      setShowDisable(false);
      setDisablePassword("");
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to disable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-50">Two-factor authentication</h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        Recommended for Owner and Accountant accounts, since they reach pricing/cost data — a compromised password
        alone shouldn't be enough to reach it.
      </p>

      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="mb-3 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      {enabled && !showDisable && (
        <div className="flex items-center justify-between">
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-300">Enabled</span>
          <button onClick={() => setShowDisable(true)} className="text-sm font-medium text-red-600 underline dark:text-red-400">
            Disable
          </button>
        </div>
      )}

      {enabled && showDisable && (
        <form onSubmit={disable} className="space-y-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Confirm your password to disable 2FA</span>
            <input
              type="password"
              required
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Disable 2FA
            </button>
            <button type="button" onClick={() => setShowDisable(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700">
              Cancel
            </button>
          </div>
        </form>
      )}

      {!enabled && !enrolling && (
        <button onClick={startEnroll} disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
          Enable 2FA
        </button>
      )}

      {!enabled && enrolling && qrDataUrl && (
        <form onSubmit={confirmEnroll} className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">Scan this with Google Authenticator, Authy, or similar — or enter the code manually.</p>
          <img src={qrDataUrl} alt="2FA QR code" className="mx-auto h-48 w-48" />
          <p className="break-all rounded-lg bg-slate-100 px-3 py-2 text-center font-mono text-xs dark:bg-slate-800">{secret}</p>
          <input
            type="text"
            inputMode="numeric"
            required
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-center text-lg tracking-widest outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            Confirm & enable
          </button>
        </form>
      )}
    </section>
  );
}

function SessionsSection() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null); // "all" for revokeAllOthers

  function load() {
    api.get<Session[]>("/sessions/mine").then(setSessions).catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function revoke(id: string) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/sessions/${id}/revoke`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to sign out that session");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeAllOthers() {
    if (busyId) return;
    setBusyId("all");
    setError(null);
    try {
      await api.post("/sessions/revoke-all-mine");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to sign out other sessions");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">Your active sessions</h2>
        {sessions.length > 1 && (
          <button onClick={revokeAllOthers} disabled={!!busyId} className="text-xs font-medium text-red-600 underline disabled:opacity-50 dark:text-red-400">
            {busyId === "all" ? "Signing out…" : "Sign out everywhere else"}
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Sessions expire automatically after 30 minutes of inactivity. Sign out of any device you don't recognize —
        e.g. a shared warehouse phone you forgot to log out of.
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between py-2 text-sm">
            <div>
              <div className="text-slate-700 dark:text-slate-300">
                {s.userAgent ? s.userAgent.slice(0, 60) : "Unknown device"} {s.current && <span className="text-green-600 dark:text-green-400">(this device)</span>}
              </div>
              <div className="text-xs text-slate-400">Last active {new Date(s.lastSeenAt).toLocaleString()}</div>
            </div>
            {!s.current && (
              <button onClick={() => revoke(s.id)} disabled={!!busyId} className="text-xs font-medium text-red-600 underline disabled:opacity-50 dark:text-red-400">
                {busyId === s.id ? "Signing out…" : "Sign out"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AllSessionsSection() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api.get<Session[]>("/sessions").then(setSessions).catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function revoke(id: string) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await api.post(`/sessions/${id}/revoke`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke that session");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-50">All active sessions (Owner)</h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        Immediately sign someone out — e.g. a lost phone or someone who's left the company — without waiting for a
        password change to take effect.
      </p>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between py-2 text-sm">
            <div>
              <div className="text-slate-700 dark:text-slate-300">
                {s.user?.name} <span className="text-slate-400">({s.user?.role})</span>
              </div>
              <div className="text-xs text-slate-400">
                {s.userAgent ? s.userAgent.slice(0, 50) : "Unknown device"} · Last active {new Date(s.lastSeenAt).toLocaleString()}
              </div>
            </div>
            <button onClick={() => revoke(s.id)} disabled={!!busyId} className="text-xs font-medium text-red-600 underline disabled:opacity-50 dark:text-red-400">
              {busyId === s.id ? "Revoking…" : "Revoke"}
            </button>
          </li>
        ))}
        {sessions.length === 0 && !error && <li className="py-2 text-sm text-slate-500 dark:text-slate-400">No active sessions.</li>}
      </ul>
    </section>
  );
}

function AuditIntegritySection() {
  const [result, setResult] = useState<{ valid: boolean; brokenAtId?: string } | null>(null);
  const [checking, setChecking] = useState(false);

  async function verify() {
    setChecking(true);
    try {
      const res = await api.get<{ valid: boolean; brokenAtId?: string }>("/reports/audit-log/verify");
      setResult(res);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-1 text-base font-semibold text-slate-900 dark:text-slate-50">Audit log integrity</h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        The audit log is tamper-evident — every entry is chained to the one before it. This recomputes the chain to
        confirm nothing has been altered.
      </p>
      <button onClick={verify} disabled={checking} className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700">
        {checking ? "Checking…" : "Verify audit log"}
      </button>
      {result && (
        <p className={`mt-2 text-sm ${result.valid ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
          {result.valid ? "Chain intact — no tampering detected." : `Chain broken at entry ${result.brokenAtId}.`}
        </p>
      )}
    </section>
  );
}
