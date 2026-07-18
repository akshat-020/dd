import { useEffect, useState } from "react";
import { api, ApiError, qrImageUrl } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { Location } from "../api/types";
import { LabelPrintPanel } from "../components/LabelPrintPanel";

export default function LocationsPage() {
  const { user } = useAuth();
  // Warehouse's visibility is task-scoped (see the permission model): no
  // general location browsing, only the standalone lookup-by-code search.
  // This applies to the WAREHOUSE role specifically, never to a Sales
  // account even if it's been granted scan access — that grant only adds
  // scan actions, it never narrows Sales' normal full visibility.
  if (user?.role === "WAREHOUSE") {
    return <LocationLookupOnly />;
  }
  return <LocationsFullView />;
}

function LocationLookupOnly() {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<Location | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setSearching(true);
    setError(null);
    setResult(null);
    try {
      const loc = await api.get<Location>(`/locations/by-code/${encodeURIComponent(code.trim())}`);
      setResult(loc);
    } catch {
      setError(`No location found for code "${code.trim()}"`);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Location Lookup</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Look up a single location by its code. General stock/location browsing isn't available on
        this account — use your assigned pick list or putaway task for that.
      </p>

      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. A-03-02"
          className="flex-1 rounded-lg border border-slate-300 px-3 py-3 font-mono outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
        <button type="submit" disabled={searching} className="rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
          {searching ? "…" : "Search"}
        </button>
      </form>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {result && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="font-mono text-lg font-bold text-slate-900 dark:text-slate-50">{result.code}</div>
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Zone {result.zone} · Rack {result.rack}
            {result.bin ? ` · Bin ${result.bin}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}

function LocationsFullView() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("masterdata.editLocation");
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", zone: "", rack: "", bin: "" });
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState<{ created: string[]; skipped: string[] } | null>(null);
  const [showPrintSheet, setShowPrintSheet] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api
      .get<Location[]>("/locations")
      .then(setLocations)
      .catch((e) => setError(e.message));
  }

  useEffect(load, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/locations", { code: form.code, zone: form.zone, rack: form.rack, bin: form.bin || undefined });
      setForm({ code: "", zone: "", rack: "", bin: "" });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create location");
    } finally {
      setSubmitting(false);
    }
  }

  // Parses "code,zone,rack,bin" lines, per the section-10 setup plan: map
  // the space in a spreadsheet first, then bulk-load it here.
  async function handleBulkImport(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const rows = bulkText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [code, zone, rack, bin] = line.split(",").map((s) => s.trim());
        return { code, zone, rack, bin: bin || undefined };
      });
    if (rows.length === 0) return;
    try {
      const res = await api.post<{ created: string[]; skipped: string[] }>("/locations/bulk-import", { locations: rows });
      setBulkResult(res);
      setBulkText("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Bulk import failed");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Location Master</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowPrintSheet((v) => !v)}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
          >
            {showPrintSheet ? "Hide" : "Print QR labels"}
          </button>
          {canEdit && (
            <button
              onClick={() => setShowForm((v) => !v)}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
            >
              {showForm ? "Cancel" : "+ Add / Import"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {showForm && (
        <div className="space-y-4">
          <form onSubmit={handleCreate} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Add a single location</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code (e.g. A-03-02)" value={form.code} onChange={(v) => setForm({ ...form, code: v })} required />
              <Field label="Zone" value={form.zone} onChange={(v) => setForm({ ...form, zone: v })} required />
              <Field label="Rack" value={form.rack} onChange={(v) => setForm({ ...form, rack: v })} required />
              <Field label="Bin (optional)" value={form.bin} onChange={(v) => setForm({ ...form, bin: v })} />
            </div>
            <button type="submit" disabled={submitting} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
              {submitting ? "Saving…" : "Save location"}
            </button>
          </form>

          <form onSubmit={handleBulkImport} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Bulk import from your location spreadsheet</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">One per line: code,zone,rack,bin — e.g. A-03-02,A,03,02</p>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              placeholder={"A-01-01,A,01,01\nA-01-02,A,01,02"}
            />
            <button type="submit" className="w-full rounded-lg border border-slate-300 px-4 py-3 font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300">
              Import
            </button>
            {bulkResult && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Created {bulkResult.created.length}, skipped {bulkResult.skipped.length} (already existed).
              </p>
            )}
          </form>
        </div>
      )}

      {showPrintSheet && <PrintSheet locations={locations} />}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2">Code</th>
              <th className="px-4 py-2">Zone</th>
              <th className="px-4 py-2">Rack</th>
              <th className="px-4 py-2">Bin</th>
              <th className="px-4 py-2">Status</th>
              {canEdit && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {locations.map((l) => (
              <LocationRow key={l.id} location={l} canEdit={canEdit} onChanged={load} />
            ))}
          </tbody>
        </table>
        {locations.length === 0 && <p className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No locations yet.</p>}
      </div>
    </div>
  );
}

function LocationRow({ location, canEdit, onChanged }: { location: Location; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ zone: location.zone, rack: location.rack, bin: location.bin ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [deactivateOffer, setDeactivateOffer] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.patch(`/locations/${location.id}`, { zone: form.zone, rack: form.rack, bin: form.bin || undefined });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save changes");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (deleting || !confirm(`Delete location ${location.code}?`)) return;
    setError(null);
    setDeactivateOffer(false);
    setDeleting(true);
    try {
      await api.delete(`/locations/${location.id}`);
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.body?.canDeactivate) setDeactivateOffer(true);
      } else {
        setError("Failed to delete location");
      }
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeactivate() {
    if (deleting) return;
    setError(null);
    setDeactivateOffer(false);
    setDeleting(true);
    try {
      await api.patch(`/locations/${location.id}`, { active: false });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to deactivate location");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <tr>
        <td className="px-4 py-2 font-mono text-xs">{location.code}</td>
        {editing ? (
          <>
            <td className="px-4 py-2">
              <input value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} className="w-16 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800" />
            </td>
            <td className="px-4 py-2">
              <input value={form.rack} onChange={(e) => setForm({ ...form, rack: e.target.value })} className="w-16 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800" />
            </td>
            <td className="px-4 py-2">
              <input value={form.bin} onChange={(e) => setForm({ ...form, bin: e.target.value })} className="w-16 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800" />
            </td>
          </>
        ) : (
          <>
            <td className="px-4 py-2">{location.zone}</td>
            <td className="px-4 py-2">{location.rack}</td>
            <td className="px-4 py-2">{location.bin ?? "—"}</td>
          </>
        )}
        <td className="px-4 py-2">
          {location.active ? (
            <span className="text-slate-500 dark:text-slate-400">Active</span>
          ) : (
            <span className="text-slate-400">Inactive</span>
          )}
        </td>
        {canEdit && (
          <td className="px-4 py-2">
            {editing ? (
              <form onSubmit={handleSave} className="flex gap-1">
                <button type="submit" disabled={submitting} className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
                  Save
                </button>
                <button type="button" onClick={() => setEditing(false)} className="rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700">
                  Cancel
                </button>
              </form>
            ) : (
              <div className="flex gap-2">
                <button onClick={() => setEditing(true)} disabled={deleting} className="text-xs font-medium text-blue-600 underline disabled:opacity-50 dark:text-blue-400">
                  Edit
                </button>
                <button onClick={handleDelete} disabled={deleting} className="text-xs font-medium text-red-600 underline disabled:opacity-50 dark:text-red-400">
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            )}
          </td>
        )}
      </tr>
      {(error || deactivateOffer) && (
        <tr>
          <td colSpan={canEdit ? 6 : 5} className="bg-red-50 px-4 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
            {deactivateOffer && (
              <button onClick={handleDeactivate} disabled={deleting} className="ml-2 font-medium underline disabled:opacity-50">
                {deleting ? "Deactivating…" : "Deactivate instead"}
              </button>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function PrintSheet({ locations }: { locations: Location[] }) {
  // Note: LabelPrintPanel's own `.print-area` output must never sit under a
  // `print:hidden` (display:none) ancestor — that would drop it from the
  // print output entirely, not just keep it visually hidden — so the
  // on-screen-only wrapper below stops short of wrapping it.
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400 print:hidden">
        Print on adhesive label sheets, laminate, and stick at a consistent position on every rack/bin.
      </p>
      {/* Not wrapped in a `print:hidden` div — LabelPrintPanel tags its own
          on-screen controls that way internally, and its print-only output
          must not sit under any display:none ancestor (see note above). */}
      <LabelPrintPanel labels={locations.map((l) => ({ id: l.id, qrUrl: qrImageUrl("location", l.id), primary: l.code }))} />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 print:hidden">
        {locations.map((l) => (
          <div key={l.id} className="flex flex-col items-center rounded-lg border border-slate-200 p-2 text-center dark:border-slate-700">
            <img src={qrImageUrl("location", l.id)} alt={l.code} className="h-24 w-24" />
            <span className="mt-1 font-mono text-xs font-semibold">{l.code}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
      <input
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      />
    </label>
  );
}
