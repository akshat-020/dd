import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { CompanySettings } from "../api/types";

// Round 4 #5/#6: company-wide settings that used to be either hard-coded
// or missing entirely — bank details shown on a Proforma Invoice, and the
// label print layout (single-label thermal/continuous-feed vs grid/sheet),
// set once here rather than baked into one printer type.
export default function SettingsPage() {
  const [form, setForm] = useState<CompanySettings>({
    bankAccountName: "",
    bankAccountNumber: "",
    bankIfsc: "",
    bankName: "",
    labelPrintFormat: "GRID",
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get<CompanySettings>("/settings")
      .then((s) =>
        setForm({
          bankAccountName: s.bankAccountName ?? "",
          bankAccountNumber: s.bankAccountNumber ?? "",
          bankIfsc: s.bankIfsc ?? "",
          bankName: s.bankName ?? "",
          labelPrintFormat: s.labelPrintFormat,
        })
      )
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load settings"));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.put("/settings", form);
      setNotice("Settings saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Company settings</h1>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      <form onSubmit={handleSave} className="space-y-4">
        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Bank details</h2>
          <p className="text-xs text-slate-400">Shown on every Proforma Invoice, for buyers collecting advance payment.</p>
          <Field label="Account name" value={form.bankAccountName ?? ""} onChange={(v) => setForm({ ...form, bankAccountName: v })} />
          <Field label="Account number" value={form.bankAccountNumber ?? ""} onChange={(v) => setForm({ ...form, bankAccountNumber: v })} />
          <Field label="IFSC" value={form.bankIfsc ?? ""} onChange={(v) => setForm({ ...form, bankIfsc: v })} />
          <Field label="Bank name" value={form.bankName ?? ""} onChange={(v) => setForm({ ...form, bankName: v })} />
        </section>

        <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Label print format</h2>
          <p className="text-xs text-slate-400">
            Printer type isn't fixed — pick whichever matches what's actually in use, and every label print (SKU batches, locations)
            follows it.
          </p>
          <div className="flex gap-2">
            {(["SINGLE", "GRID"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setForm({ ...form, labelPrintFormat: f })}
                className={`flex-1 rounded-lg border px-3 py-3 text-sm font-medium ${
                  form.labelPrintFormat === f
                    ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                    : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"
                }`}
              >
                {f === "SINGLE" ? "Single label (thermal / continuous-feed)" : "Grid (regular printer + adhesive sheets)"}
              </button>
            ))}
          </div>
        </section>

        <button type="submit" disabled={saving} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
          {saving ? "Saving…" : "Save settings"}
        </button>
      </form>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      />
    </label>
  );
}
