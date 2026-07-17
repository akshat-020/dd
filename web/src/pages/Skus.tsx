import { useEffect, useMemo, useState } from "react";
import { api, ApiError, qrImageUrl } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { PurchaseCostReference, Sku, SkuBatch, StockSummaryEntry } from "../api/types";
import { compoundBreakdown } from "../lib/units";
import { LabelPrintPanel } from "../components/LabelPrintPanel";

export default function SkusPage() {
  const { hasRole } = useAuth();
  const canEdit = hasRole("OWNER", "ACCOUNTANT", "WAREHOUSE");
  const canSeeStock = hasRole("OWNER", "ACCOUNTANT", "SALES");
  const [skus, setSkus] = useState<Sku[]>([]);
  const [stockBySku, setStockBySku] = useState<Map<string, number>>(new Map());
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ code: "", name: "", unit: "", category: "", reorderThreshold: "0", altUnitName: "", altUnitFactor: "" });
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api
      .get<Sku[]>("/skus")
      .then(setSkus)
      .catch((e) => setError(e.message));
    if (canSeeStock) {
      api
        .get<StockSummaryEntry[]>("/stock/summary")
        .then((rows) => setStockBySku(new Map(rows.map((r) => [r.skuId, r.totalQty]))))
        .catch(() => {});
    }
  }

  useEffect(load, [canSeeStock]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return skus;
    return skus.filter((s) => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q) || (s.category ?? "").toLowerCase().includes(q));
  }, [skus, search]);

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
        altUnitName: form.altUnitName || undefined,
        altUnitFactor: form.altUnitFactor ? Number(form.altUnitFactor) : undefined,
      });
      setForm({ code: "", name: "", unit: "", category: "", reorderThreshold: "0", altUnitName: "", altUnitFactor: "" });
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

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by code, name, or category…"
        className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      />

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
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              Alternate unit (optional) — e.g. Box, sold/stored as a multiple of the base unit above.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Alt unit name" value={form.altUnitName} onChange={(v) => setForm({ ...form, altUnitName: v })} />
              <Field
                label={`1 ${form.altUnitName || "alt unit"} = how many ${form.unit || "base units"}`}
                type="number"
                value={form.altUnitFactor}
                onChange={(v) => setForm({ ...form, altUnitFactor: v })}
              />
            </div>
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
              {canSeeStock && <th className="px-4 py-2">In stock</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {filtered.map((s) => (
              <SkuRow
                key={s.id}
                sku={s}
                qty={canSeeStock ? stockBySku.get(s.id) ?? 0 : null}
                expanded={expandedId === s.id}
                onToggle={() => setExpandedId(expandedId === s.id ? null : s.id)}
                canSeeStock={canSeeStock}
                canEdit={canEdit}
                onSaved={load}
              />
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No SKUs match.</p>}
      </div>
    </div>
  );
}

function SkuRow({
  sku,
  qty,
  expanded,
  onToggle,
  canSeeStock,
  canEdit,
  onSaved,
}: {
  sku: Sku;
  qty: number | null;
  expanded: boolean;
  onToggle: () => void;
  canSeeStock: boolean;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const canExpand = canSeeStock || canEdit;
  return (
    <>
      <tr onClick={canExpand ? onToggle : undefined} className={canExpand ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800" : undefined}>
        <td className="px-4 py-2 font-mono text-xs">{sku.code}</td>
        <td className="px-4 py-2 text-slate-900 dark:text-slate-50">{sku.name}</td>
        <td className="px-4 py-2">
          {sku.unit}
          {sku.altUnitName && sku.altUnitFactor && (
            <span className="ml-1 text-xs text-slate-400">
              (1 {sku.altUnitName} = {sku.altUnitFactor})
            </span>
          )}
        </td>
        <td className="px-4 py-2">{sku.category ?? "—"}</td>
        {canSeeStock && (
          <td className={`px-4 py-2 ${qty !== null && qty <= sku.reorderThreshold ? "text-red-600 dark:text-red-400" : ""}`}>
            {qty}
            {qty !== null && compoundBreakdown(qty, sku) && <span className="ml-1 text-xs text-slate-400">({compoundBreakdown(qty, sku)})</span>}
            {" "}
            {canExpand && (expanded ? "▲" : "▼")}
          </td>
        )}
      </tr>
      {expanded && (
        <tr>
          <td colSpan={canSeeStock ? 5 : 4} className="bg-slate-50 px-4 py-3 dark:bg-slate-800">
            {canEdit && <SkuEditForm sku={sku} onSaved={onSaved} />}
            {canSeeStock && <BatchHistory skuId={sku.id} skuCode={sku.code} />}
          </td>
        </tr>
      )}
    </>
  );
}

function SkuEditForm({ sku, onSaved }: { sku: Sku; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: sku.name,
    unit: sku.unit,
    category: sku.category ?? "",
    reorderThreshold: String(sku.reorderThreshold),
    altUnitName: sku.altUnitName ?? "",
    altUnitFactor: sku.altUnitFactor != null ? String(sku.altUnitFactor) : "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set when the server warns that changing an existing conversion factor
  // affects a SKU that already has stock or open orders — offering a
  // "confirm and proceed" action instead of just failing (see Section 1 of
  // the addendum: the change only applies going forward, never retroactive).
  const [factorWarning, setFactorWarning] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    setSubmitting(true);
    setError(null);
    setFactorWarning(null);
    try {
      await api.patch(`/skus/${sku.id}`, {
        name: form.name,
        unit: form.unit,
        category: form.category || undefined,
        reorderThreshold: Number(form.reorderThreshold) || 0,
        altUnitName: form.altUnitName || undefined,
        altUnitFactor: form.altUnitFactor ? Number(form.altUnitFactor) : undefined,
      });
      setEditing(false);
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.body?.requiresConfirmation) {
        setFactorWarning(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Failed to save changes");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleConfirmFactorChange() {
    setSubmitting(true);
    setError(null);
    try {
      await api.patch(`/skus/${sku.id}`, {
        name: form.name,
        unit: form.unit,
        category: form.category || undefined,
        reorderThreshold: Number(form.reorderThreshold) || 0,
        altUnitName: form.altUnitName || undefined,
        altUnitFactor: form.altUnitFactor ? Number(form.altUnitFactor) : undefined,
        confirmFactorChange: true,
      });
      setFactorWarning(null);
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save changes");
    } finally {
      setSubmitting(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="mb-3 text-xs font-medium text-blue-600 underline dark:text-blue-400"
      >
        Edit SKU details
      </button>
    );
  }

  return (
    <form onSubmit={handleSave} onClick={(e) => e.stopPropagation()} className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-xs text-slate-400">Code {sku.code} can't be changed — it's what QR labels and stock history reference.</p>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <Field label="Unit" value={form.unit} onChange={(v) => setForm({ ...form, unit: v })} required />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Category" value={form.category} onChange={(v) => setForm({ ...form, category: v })} />
        <Field label="Reorder threshold" type="number" value={form.reorderThreshold} onChange={(v) => setForm({ ...form, reorderThreshold: v })} />
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
          Alternate unit (optional) — e.g. Box, sold/stored as a multiple of the base unit above.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Alt unit name" value={form.altUnitName} onChange={(v) => setForm({ ...form, altUnitName: v })} />
          <Field
            label={`1 ${form.altUnitName || "alt unit"} = how many ${form.unit || "base units"}`}
            type="number"
            value={form.altUnitFactor}
            onChange={(v) => setForm({ ...form, altUnitFactor: v })}
          />
        </div>
      </div>
      {factorWarning && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <p>{factorWarning}</p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              handleConfirmFactorChange();
            }}
            disabled={submitting}
            className="mt-1 font-medium underline disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Yes, change it anyway (applies going forward only)"}
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(false);
          }}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs dark:border-slate-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function BatchHistory({ skuId, skuCode }: { skuId: string; skuCode: string }) {
  const { hasRole } = useAuth();
  const canSeeCost = hasRole("OWNER", "ACCOUNTANT");
  const [batches, setBatches] = useState<SkuBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<SkuBatch[]>(`/stock/batches?skuId=${skuId}`)
      .then(setBatches)
      .catch((e) => setError(e.message));
  }, [skuId]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!batches) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading batches…</p>;
  if (batches.length === 0) return <p className="text-sm text-slate-500 dark:text-slate-400">No batches logged yet for {skuCode}.</p>;

  return (
    <div className="space-y-2">
      <LabelPrintPanel
        triggerLabel="Print these labels"
        labels={batches.map((b) => ({
          id: b.id,
          qrUrl: qrImageUrl("batch", b.id),
          primary: skuCode,
          secondary: [b.batchCode, new Date(b.receivedDate).toLocaleDateString()],
        }))}
      />
      <div className="flex flex-wrap gap-3 print:hidden">
        {batches.map((b) => (
          <BatchCard key={b.id} batch={b} canSeeCost={canSeeCost} />
        ))}
      </div>
    </div>
  );
}

function BatchCard({ batch, canSeeCost }: { batch: SkuBatch; canSeeCost: boolean }) {
  const [showCost, setShowCost] = useState(false);

  return (
    <div className="flex w-40 flex-col items-center rounded-lg border border-slate-200 bg-white p-2 text-center dark:border-slate-700 dark:bg-slate-900">
      <img src={qrImageUrl("batch", batch.id)} alt={batch.batchCode} className="h-20 w-20" />
      <span className="mt-1 font-mono text-xs font-semibold">{batch.batchCode}</span>
      <span className="text-xs text-slate-400">
        {new Date(batch.receivedDate).toLocaleDateString()} · {batch.sourceType}
      </span>
      {batch.receivedQuantity != null && <span className="text-xs text-slate-400">Qty: {batch.receivedQuantity}</span>}
      {batch.supplierRef && <span className="text-xs text-slate-400">Ref: {batch.supplierRef}</span>}
      {canSeeCost && (
        <button onClick={() => setShowCost((v) => !v)} className="mt-1 text-xs font-medium text-blue-600 underline dark:text-blue-400">
          {showCost ? "Hide cost" : "Cost"}
        </button>
      )}
      {showCost && <CostReferencePanel batchId={batch.id} />}
    </div>
  );
}

function CostReferencePanel({ batchId }: { batchId: string }) {
  const [refs, setRefs] = useState<PurchaseCostReference[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ quantity: "", unitCost: "", supplierRef: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api
      .get<PurchaseCostReference[]>(`/stock/batches/${batchId}/cost-references`)
      .then(setRefs)
      .catch((e) => setError(e.message));
  }

  useEffect(load, [batchId]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/stock/batches/${batchId}/cost-references`, {
        quantity: Number(form.quantity),
        unitCost: Number(form.unitCost),
        supplierRef: form.supplierRef || undefined,
        note: form.note || undefined,
      });
      setForm({ quantity: "", unitCost: "", supplierRef: "", note: "" });
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add cost reference");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-1 w-full space-y-1 border-t border-slate-100 pt-1 text-left dark:border-slate-800">
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {refs?.map((r) => (
        <div key={r.id} className="text-xs text-slate-500 dark:text-slate-400">
          {r.quantity} × ₹{r.unitCost} = ₹{(r.quantity * r.unitCost).toFixed(2)}
          {r.supplierRef ? ` (${r.supplierRef})` : ""}
        </div>
      ))}
      {refs?.length === 0 && !showForm && <p className="text-xs text-slate-400">No cost recorded yet.</p>}
      {!showForm ? (
        <button onClick={() => setShowForm(true)} className="text-xs font-medium text-slate-500 underline dark:text-slate-400">
          + Add cost
        </button>
      ) : (
        <form onSubmit={handleAdd} className="space-y-1">
          <input
            type="number"
            min={1}
            required
            placeholder="Qty"
            value={form.quantity}
            onChange={(e) => setForm({ ...form, quantity: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
          />
          <input
            type="number"
            min={0}
            step="0.01"
            required
            placeholder="Unit cost"
            value={form.unitCost}
            onChange={(e) => setForm({ ...form, unitCost: e.target.value })}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
          />
          <button type="submit" disabled={submitting} className="w-full rounded bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            {submitting ? "Saving…" : "Save"}
          </button>
        </form>
      )}
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
