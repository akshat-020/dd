import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { IntegrationTokenInfo, Party, PartyImportResponse, PartyTag } from "../api/types";
import { parseCsv, rowsToObjects } from "../lib/csv";

// Party/contact master — the one list of buyers, vendors, staff and
// transporters shared by orders and the call desk. See
// docs/call-desk/COMBINED_PLAN.md (gap G1). VIP-class tags are Owner-only,
// and family contacts never appear for anyone else (enforced server-side).

const TAG_LABELS: Record<PartyTag, string> = {
  VIP_FAMILY: "VIP – Family",
  VIP_FINANCE: "VIP – Bank/CA/Finance",
  BUYER_TOP: "Top buyer",
  BUYER: "Buyer",
  LEAD: "New lead",
  VENDOR_KEY: "Key vendor",
  VENDOR: "Vendor",
  STAFF: "Staff",
  TRANSPORT: "Transport/driver",
  PARTNER: "Broker/partner",
  GOVT: "Govt/legal",
  BLOCK: "Block (spam)",
  UNKNOWN: "Unknown",
};
const OWNER_ONLY_TAGS: PartyTag[] = ["VIP_FAMILY", "VIP_FINANCE", "BUYER_TOP", "VENDOR_KEY"];
const TEMPLATE_HEADER = "name,firm,city,tag,phone,phone2,owner_staff,backup_staff,language,voice_only,record_calls,notes";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-base outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100";
const buttonClass = "rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300";
const primaryClass = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900";

interface FormState {
  name: string;
  firm: string;
  city: string;
  tag: PartyTag;
  phones: string;
  ownerStaff: string;
  voiceOnly: boolean;
  notes: string;
}
const emptyForm: FormState = { name: "", firm: "", city: "", tag: "UNKNOWN", phones: "", ownerStaff: "", voiceOnly: false, notes: "" };

function toForm(p: Party): FormState {
  return {
    name: p.name,
    firm: p.firm ?? "",
    city: p.city ?? "",
    tag: p.tag,
    phones: p.phones.map((ph) => ph.phone).join(", "),
    ownerStaff: p.ownerStaff ?? "",
    voiceOnly: p.voiceOnly,
    notes: p.notes ?? "",
  };
}

export default function PartiesPage() {
  const { hasRole, hasPermission } = useAuth();
  const isOwner = hasRole("OWNER");
  const canEdit = hasPermission("parties.edit");
  const [parties, setParties] = useState<Party[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Party | "new" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [importResult, setImportResult] = useState<PartyImportResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function load(q = search) {
    api
      .get<Party[]>(`/parties${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
      .then(setParties)
      .catch((e) => setError(e.message));
  }

  useEffect(() => {
    const t = setTimeout(() => load(search), search ? 250 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const assignableTags = (Object.keys(TAG_LABELS) as PartyTag[]).filter((t) => isOwner || !OWNER_ONLY_TAGS.includes(t));
  const lockedTag = editing && editing !== "new" && !isOwner && OWNER_ONLY_TAGS.includes(editing.tag);

  function startEdit(target: Party | "new") {
    setEditing(target);
    setForm(target === "new" ? emptyForm : toForm(target));
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    const body = {
      name: form.name,
      firm: form.firm || undefined,
      city: form.city || undefined,
      ...(lockedTag ? {} : { tag: form.tag }),
      ownerStaff: form.ownerStaff || undefined,
      voiceOnly: form.voiceOnly,
      notes: form.notes || undefined,
      phones: form.phones
        .split(/[,;\n]/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((phone) => ({ phone })),
    };
    try {
      if (editing === "new") await api.post<Party>("/parties", body);
      else await api.patch<Party>(`/parties/${editing.id}`, body);
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function handleImport(file: File) {
    setError(null);
    setImportResult(null);
    try {
      const rows = rowsToObjects(parseCsv(await file.text()));
      if (rows.length === 0) {
        setError("That file has no data rows.");
        return;
      }
      setBusy(true);
      setImportResult(await api.post<PartyImportResponse>("/parties/import", { rows }));
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't read that file — save it from Excel as CSV.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE_HEADER + "\n"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Contacts</h1>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <button onClick={downloadTemplate} className={buttonClass}>
              Template
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy} className={buttonClass}>
              Import CSV
            </button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])} />
            <button onClick={() => startEdit("new")} className={primaryClass}>
              Add contact
            </button>
          </div>
        )}
      </div>

      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, firm, city or phone" className={inputClass} />

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {importResult && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
          <p className="font-medium">
            Import: {importResult.created} added · {importResult.updated} updated · {importResult.errors} with problems
          </p>
          {importResult.errors > 0 && (
            <ul className="mt-2 list-disc pl-5 text-red-700 dark:text-red-300">
              {importResult.results
                .filter((r) => r.status === "error")
                .map((r) => (
                  <li key={r.row}>
                    Row {r.row}: {r.error}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {editing && (
        <form onSubmit={save} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="grid grid-cols-2 gap-3">
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name *" className={inputClass} />
            <input value={form.firm} onChange={(e) => setForm({ ...form, firm: e.target.value })} placeholder="Firm" className={inputClass} />
            <input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="City" className={inputClass} />
            <select
              value={form.tag}
              disabled={!!lockedTag}
              onChange={(e) => setForm({ ...form, tag: e.target.value as PartyTag })}
              className={inputClass}
              title={lockedTag ? "Only the Owner can change a VIP tag" : undefined}
            >
              {(lockedTag ? [form.tag] : assignableTags).map((t) => (
                <option key={t} value={t}>
                  {TAG_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <input
            required
            value={form.phones}
            onChange={(e) => setForm({ ...form, phones: e.target.value })}
            placeholder="Phone(s) * — separate with commas"
            inputMode="tel"
            className={inputClass}
          />
          <div className="grid grid-cols-2 gap-3">
            <input value={form.ownerStaff} onChange={(e) => setForm({ ...form, ownerStaff: e.target.value })} placeholder="Handled by (staff)" className={inputClass} />
            <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input type="checkbox" checked={form.voiceOnly} onChange={(e) => setForm({ ...form, voiceOnly: e.target.checked })} />
              Can't read messages (voice only)
            </label>
          </div>
          <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Notes" rows={2} className={inputClass} />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={primaryClass}>
              Save
            </button>
            <button type="button" onClick={() => setEditing(null)} className={buttonClass}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Phone</th>
              <th className="px-4 py-2">Handled by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {parties.map((p) => (
              <tr
                key={p.id}
                onClick={() => canEdit && startEdit(p)}
                className={`text-slate-800 dark:text-slate-200 ${canEdit ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800" : ""}`}
              >
                <td className="px-4 py-2">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">{[p.firm, p.city].filter(Boolean).join(" · ")}</div>
                </td>
                <td className="px-4 py-2">{TAG_LABELS[p.tag] ?? p.tag}</td>
                <td className="px-4 py-2 whitespace-nowrap">{p.phones.map((ph) => ph.phone).join(", ")}</td>
                <td className="px-4 py-2">{p.ownerStaff ?? "—"}</td>
              </tr>
            ))}
            {parties.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-500 dark:text-slate-400">
                  No contacts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {isOwner && <IntegrationTokens />}
    </div>
  );
}

// Owner-only: keys for the call desk's phone system to look up callers.
function IntegrationTokens() {
  const [tokens, setTokens] = useState<IntegrationTokenInfo[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<IntegrationTokenInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    api
      .get<IntegrationTokenInfo[]>("/integration-tokens")
      .then(setTokens)
      .catch((e) => setError(e.message));
  }
  useEffect(load, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      setCreated(await api.post<IntegrationTokenInfo>("/integration-tokens", { name }));
      setName("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create key");
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this key? The phone system will stop recognising callers until it gets a new key.")) return;
    await api.post(`/integration-tokens/${id}/revoke`);
    load();
  }

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="font-semibold text-slate-900 dark:text-slate-50">Phone system keys</h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Lets the call desk look up who is calling and their order status (never prices). Give the key only to whoever sets up the phone system.
      </p>
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {created?.token && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <p className="font-medium">Copy this key now — it won't be shown again:</p>
          <code className="mt-1 block break-all select-all">{created.token}</code>
          <p className="mt-1 text-xs">Send it in the request header: x-integration-token</p>
        </div>
      )}
      <form onSubmit={create} className="flex gap-2">
        <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. Exotel" className={inputClass} />
        <button type="submit" className={primaryClass}>
          Create
        </button>
      </form>
      <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
        {tokens.map((t) => (
          <li key={t.id} className="flex items-center justify-between py-2 text-slate-800 dark:text-slate-200">
            <span>
              {t.name}
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {t.revokedAt ? "revoked" : t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleString()}` : "never used"}
              </span>
            </span>
            {!t.revokedAt && (
              <button onClick={() => revoke(t.id)} className={buttonClass}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
