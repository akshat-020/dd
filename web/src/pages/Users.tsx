import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Role, User } from "../api/types";
import { PERMISSION_GROUPS, type PermissionKey } from "../lib/permissions";

const ROLES: Role[] = ["OWNER", "ACCOUNTANT", "SALES", "WAREHOUSE"];

// Access Control Model: a role is only ever the starting template applied
// once when an account is created (server-side, see routes/users.ts) —
// every permission below stays individually adjustable per person from
// that point on, with no need to change someone's role just because their
// actual job doesn't match the template exactly. Only the Owner can
// grant/revoke, and Owner accounts always have every permission (there's
// nothing to toggle for them).
export default function Users() {
  const [users, setUsers] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "SALES" as Role });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Tracks which specific user+permission toggle is mid-flight, so only
  // that one control disables and a rapid double-click can't double-fire.
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

  async function toggleActive(user: User) {
    const key = `${user.id}:active`;
    if (togglingKey) return;
    setTogglingKey(key);
    setError(null);
    try {
      await api.patch(`/users/${user.id}`, { active: !user.active });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update user");
    } finally {
      setTogglingKey(null);
    }
  }

  async function togglePermission(user: User, permission: PermissionKey, granted: boolean) {
    const key = `${user.id}:${permission}`;
    if (togglingKey) return;
    setTogglingKey(key);
    setError(null);
    try {
      if (granted) await api.delete(`/users/${user.id}/permissions/${permission}`);
      else await api.put(`/users/${user.id}/permissions/${permission}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update permission");
    } finally {
      setTogglingKey(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
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
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Role — just a starting template; every permission stays individually adjustable afterward.
            </span>
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
          </label>
          <button type="submit" disabled={submitting} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            {submitting ? "Saving…" : "Create user"}
          </button>
        </form>
      )}

      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {users.map((u) => (
          <li key={u.id} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium text-slate-900 dark:text-slate-50">{u.name}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {u.email} · {u.role}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => toggleActive(u)}
                  disabled={togglingKey === `${u.id}:active`}
                  className={`rounded-full px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                    u.active ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800"
                  }`}
                >
                  {togglingKey === `${u.id}:active` ? "…" : u.active ? "Active" : "Disabled"}
                </button>
                {u.role === "OWNER" ? (
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    Owner — all permissions
                  </span>
                ) : (
                  <button
                    onClick={() => setExpandedId(expandedId === u.id ? null : u.id)}
                    className="text-xs font-medium text-blue-600 underline dark:text-blue-400"
                  >
                    {expandedId === u.id ? "Hide permissions" : `Permissions (${u.permissions.length})`}
                  </button>
                )}
              </div>
            </div>

            {expandedId === u.id && u.role !== "OWNER" && (
              <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                {PERMISSION_GROUPS.map((group) => (
                  <div key={group.label}>
                    <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{group.label}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {group.permissions.map((p) => {
                        const granted = u.permissions.includes(p.key);
                        const key = `${u.id}:${p.key}`;
                        return (
                          <button
                            key={p.key}
                            title={p.label}
                            onClick={() => togglePermission(u, p.key, granted)}
                            disabled={togglingKey === key}
                            className={`rounded-full border px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                              granted
                                ? "border-blue-300 bg-blue-100 text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-300"
                                : "border-slate-300 bg-white text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                            }`}
                          >
                            {togglingKey === key ? "…" : p.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
