import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [requiresTotp, setRequiresTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password, totpCode || undefined);
      navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.body?.requiresTotp) {
        setRequiresTotp(true);
        setError(totpCode ? "Invalid two-factor code." : "Enter your two-factor authentication code.");
      } else {
        setError(err instanceof ApiError ? err.message : "Login failed");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-100 px-4 dark:bg-slate-950">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl bg-white p-6 shadow dark:bg-slate-900">
        <h1 className="mb-1 text-2xl font-semibold text-slate-900 dark:text-slate-50">OMS / ERP</h1>
        <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">Sign in to continue</p>

        <label className="mb-3 block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Email</span>
          <input
            type="email"
            required
            autoFocus
            disabled={requiresTotp}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-slate-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        <label className="mb-4 block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Password</span>
          <input
            type="password"
            required
            disabled={requiresTotp}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-slate-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        {requiresTotp && (
          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Two-factor code</span>
            <input
              type="text"
              inputMode="numeric"
              required
              autoFocus
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              placeholder="6-digit code from your authenticator app"
              className="w-full rounded-lg border border-slate-300 px-3 py-3 text-center text-lg tracking-widest outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
        )}

        {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-lg bg-slate-900 px-4 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {submitting ? "Signing in…" : requiresTotp ? "Verify code" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
