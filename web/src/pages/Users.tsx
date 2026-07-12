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
    await api.patch(`/users/${user.id}`, { active: !user.active });
    load();
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
          <li key={u.id} className="flex items-center justify-between px-4 py-3">
            <div>
              <div className="font-medium text-slate-900 dark:text-slate-50">{u.name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{u.email} · {u.role}</div>
            </div>
            <button
              onClick={() => toggleActive(u)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                u.active ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" : "bg-slate-100 text-slate-500 dark:bg-slate-800"
              }`}
            >
              {u.active ? "Active" : "Disabled"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
