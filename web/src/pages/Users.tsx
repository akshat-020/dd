import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Role, User } from "../api/types";

const ROLES: Role[] = ["OWNER", "ACCOUNTANT", "SALES", "WAREHOUSE"];

export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "SALES" as Role });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Tracks which specific user+field toggle is mid-flight (e.g.
  // "userId:active"), so only that one button disables — and a rapid
  // double-click can't fire the same PATCH twice.
  const [togglingKey, setTogglingKey] = useState<string | null>(null);

  function load() {
    api
      .get<User[]>("/users")
      .then(setUsers)
      .catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/users", form);
      setForm({ name: "", email: "", password: "", role: "SALES" });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create user");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleField(user: User, field: "active" | "canScanPutaway" | "canLogInwardEntry") {
    const key = `${user.id}:${field}`;
    if (togglingKey) return;
    setTogglingKey(key);
    setError(null);
    try {
      await api.patch(`/users/${user.id}`, { [field]: !user[field] });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update user");
    } finally {
      setTogglingKey(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Users</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
        >
          {showForm ? "Cancel" : "+ Add user"}
        </button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {showForm && (
        <form onSubmit={handleCreate} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <input
            required
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <input
            required
            type="email"
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <input
            required
            type="password"
            placeholder="Temporary password (min 6 chars)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit" disabled={submitting} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            {submitting ? "Saving…" : "Create user"}
          </button>
        </form>
      )}

      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {users.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div>
              <div className="font-medium text-slate-900 dark:text-slate-50">{u.name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{u.email} · {u.role}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {u.role === "SALES" && (
                <>
                  <button
                    onClick={() => toggleField(u, "canScanPutaway")}
                    disabled={togglingKey === `${u.id}:canScanPutaway`}
                    title="Scan-based putaway/pick — an add-on permission, not a role"
                    className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                      u.canScanPutaway
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                        : "bg-slate-100 text-slate-500 dark:bg-slate-800"
                    }`}
                  >
                    Scan access: {togglingKey === `${u.id}:canScanPutaway` ? "…" : u.canScanPutaway ? "On" : "Off"}
                  </button>
                  <button
                    onClick={() => toggleField(u, "canLogInwardEntry")}
                    disabled={togglingKey === `${u.id}:canLogInwardEntry`}
                    title="Log inward stock entries — on by default for Sales, revocable"
                    className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                      u.canLogInwardEntry
                        ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                        : "bg-slate-100 text-slate-500 dark:bg-slate-800"
                    }`}
                  >
                    Inward entry: {togglingKey === `${u.id}:canLogInwardEntry` ? "…" : u.canLogInwardEntry ? "On" : "Off"}
                  </button>
                </>
              )}
              <button
                onClick={() => toggleField(u, "active")}
                disabled={togglingKey === `${u.id}:active`}
                className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                  u.active ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800"
                }`}
              >
                {togglingKey === `${u.id}:active` ? "…" : u.active ? "Active" : "Disabled"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
