import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Order, Sku, StockSummaryEntry } from "../api/types";
import { SkuCombobox } from "../components/SkuCombobox";
import { availableUnits, toBaseQty } from "../lib/units";

interface LineDraft {
  skuId: string;
  qtyRequested: string;
  unit: string;
}

export default function OrderNew() {
  const navigate = useNavigate();
  const [skus, setSkus] = useState<Sku[]>([]);
  const [stockBySku, setStockBySku] = useState<Map<string, number>>(new Map());
  const [committedBySku, setCommittedBySku] = useState<Map<string, number>>(new Map());
  const [buyerName, setBuyerName] = useState("");
  const [buyerContact, setBuyerContact] = useState("");
  const [vehicleCapacityNote, setVehicleCapacityNote] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ skuId: "", qtyRequested: "", unit: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<Sku[]>("/skus").then(setSkus).catch(() => {});
    // Live availability while composing — not just after the order exists.
    // availableQty is on-hand minus whatever's already committed to other
    // orders, not raw on-hand, so this doesn't offer stock that's already
    // spoken for elsewhere.
    api
      .get<StockSummaryEntry[]>("/stock/summary")
      .then((rows) => {
        setStockBySku(new Map(rows.map((r) => [r.skuId, r.availableQty])));
        setCommittedBySku(new Map(rows.map((r) => [r.skuId, r.committedQty])));
      })
      .catch(() => {});
  }, []);

  function updateLine(idx: number, patch: Partial<LineDraft>) {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l;
        const next = { ...l, ...patch };
        // Picking a new SKU resets the unit to that SKU's base unit —
        // otherwise a leftover "Box" selection from the previous SKU could
        // silently apply the wrong conversion factor.
        if (patch.skuId !== undefined && patch.skuId !== l.skuId) {
          const sku = skus.find((s) => s.id === patch.skuId);
          next.unit = sku?.unit ?? "";
        }
        return next;
      })
    );
  }

  function addLine() {
    setLines((prev) => [...prev, { skuId: "", qtyRequested: "", unit: "" }]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validLines = lines.filter((l) => l.skuId && Number(l.qtyRequested) > 0);
    if (validLines.length === 0) {
      setError("Add at least one SKU with a quantity.");
      return;
    }
    setSubmitting(true);
    try {
      const order = await api.post<Order>("/orders", {
        buyerName,
        buyerContact: buyerContact || undefined,
        vehicleCapacityNote: vehicleCapacityNote || undefined,
        lines: validLines.map((l) => ({ skuId: l.skuId, qtyRequested: Number(l.qtyRequested), unit: l.unit || undefined })),
      });
      navigate(`/orders/${order.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create order");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">New Order</h1>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Buyer name</span>
            <input
              required
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Contact (optional)</span>
            <input
              value={buyerContact}
              onChange={(e) => setBuyerContact(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">Vehicle / load note (optional)</span>
          <input
            value={vehicleCapacityNote}
            onChange={(e) => setVehicleCapacityNote(e.target.value)}
            placeholder="e.g. Tempo, max 2 tons"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
        </label>

        <div className="space-y-3">
          <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">Items</span>
          {lines.map((line, idx) => {
            const sku = skus.find((s) => s.id === line.skuId);
            const available = line.skuId ? stockBySku.get(line.skuId) ?? 0 : null;
            const requestedInUnit = Number(line.qtyRequested) || 0;
            // Availability is always tracked in the base unit — convert the
            // entered quantity before comparing.
            const requestedBase = sku && line.unit ? toBaseQty(requestedInUnit, line.unit, sku) : requestedInUnit;
            const insufficient = available !== null && requestedBase > available;
            const units = sku ? availableUnits(sku) : [];
            return (
              <div key={idx} className="space-y-1">
                <div className="flex gap-2">
                  <SkuCombobox skus={skus} value={line.skuId} onChange={(skuId) => updateLine(idx, { skuId })} quantities={stockBySku} className="flex-1" />
                  <input
                    type="number"
                    min={1}
                    placeholder="Qty"
                    value={line.qtyRequested}
                    onChange={(e) => updateLine(idx, { qtyRequested: e.target.value })}
                    className="w-20 rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                  {units.length > 1 ? (
                    <select
                      value={line.unit}
                      onChange={(e) => updateLine(idx, { unit: e.target.value })}
                      className="rounded-lg border border-slate-300 px-2 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                    >
                      {units.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  ) : (
                    sku && <span className="flex items-center px-1 text-sm text-slate-400">{sku.unit}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeLine(idx)}
                    disabled={lines.length === 1}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-slate-500 disabled:opacity-30 dark:border-slate-700"
                  >
                    ✕
                  </button>
                </div>
                {available !== null && (
                  <p className={`text-xs ${insufficient ? "text-red-600 dark:text-red-400" : "text-slate-400"}`}>
                    {available} {sku?.unit} available
                    {sku && line.unit && line.unit !== sku.unit && requestedInUnit > 0 && ` (${requestedBase} ${sku.unit} requested)`}
                    {insufficient ? " — not enough for this quantity" : ""}
                    {(committedBySku.get(line.skuId) ?? 0) > 0 && ` (${committedBySku.get(line.skuId)} already committed to other orders)`}
                  </p>
                )}
              </div>
            );
          })}
          <button type="button" onClick={addLine} className="text-sm font-medium text-slate-600 underline dark:text-slate-300">
            + Add item
          </button>
        </div>

        <button type="submit" disabled={submitting} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
          {submitting ? "Creating…" : "Create draft order"}
        </button>
      </form>
    </div>
  );
}
