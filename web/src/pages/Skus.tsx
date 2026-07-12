import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { Sku } from "../api/types";

export default function SkusPage() {
  const { hasRole } = useAuth();
  const canEdit = hasRole("OWNER", "ACCOUNTANT", "WAREHOUSE");
  const [skus, setSkus] = useState<Sku[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", unit: "", category: "", reorderThreshold: "0" });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api
      .get<Sku[]>("/skus")
      .then(setSkus)
      .catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/skus", {
        code: form.code,
        name: form.name,
        unit: form.unit,
        category: form.category || undefined,
        reorderThreshold: Number(form.reorderThreshold) || 0,
      });
      setForm({ code: "", name: "", unit: "", category: "", reorderThreshold: "0" });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create SKU");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">SKU Master</h1>
        {canEdit && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
          >
            {showForm ? "Cancel" : "+ Add SKU"}
          </button>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {showForm && (
        <form onSubmit={handleCreate} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />
            <Field label="Unit (bag, pc, kg…)" value={form.unit} onChange={(v) => setForm({ ...form, unit: v })} required />
          </div>
          <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" value={form.category} onChange={(v) => setForm({ ...form, category: v })} />
            <Field
              label="Reorder threshold"
              type="number"
              value={form.reorderThreshold}
              onChange={(v) => setForm({ ...form, reorderThreshold: v })}
            />
          </div>
          <button type="submit" disabled={submitting} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            {submitting ? "Saving…" : "Save SKU"}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Unit</th>
              <th className="px-4 py-2">Category</th>
              <th className="px-4 py-2">Reorder at</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {skus.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2 font-mono text-xs">{s.code}</td>
                <td className="px-4 py-2 text-slate-900 dark:text-slate-50">{s.name}</td>
                <td className="px-4 py-2">{s.unit}</td>
                <td className="px-4 py-2">{s.category ?? "—"}</td>
                <td className="px-4 py-2">{s.reorderThreshold}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {skus.length === 0 && <p className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No SKUs yet.</p>}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <input
        type={type}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      />
    </label>
  );
}
