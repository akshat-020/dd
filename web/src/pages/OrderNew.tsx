import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Order, Sku } from "../api/types";

interface LineDraft {
  skuId: string;
  qtyRequested: string;
}

export default function OrderNew() {
  const navigate = useNavigate();
  const [skus, setSkus] = useState<Sku[]>([]);
  const [buyerName, setBuyerName] = useState("");
  const [buyerContact, setBuyerContact] = useState("");
  const [vehicleCapacityNote, setVehicleCapacityNote] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ skuId: "", qtyRequested: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<Sku[]>("/skus").then(setSkus).catch(() => {});
  }, []);

  function updateLine(idx: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, { skuId: "", qtyRequested: "" }]);
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
        lines: validLines.map((l) => ({ skuId: l.skuId, qtyRequested: Number(l.qtyRequested) })),
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

        <div className="space-y-2">
          <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">Items</span>
          {lines.map((line, idx) => (
            <div key={idx} className="flex gap-2">
              <select
                value={line.skuId}
                onChange={(e) => updateLine(idx, { skuId: e.target.value })}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              >
                <option value="">Select SKU…</option>
                {skus.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                placeholder="Qty"
                value={line.qtyRequested}
                onChange={(e) => updateLine(idx, { qtyRequested: e.target.value })}
                className="w-24 rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => removeLine(idx)}
                disabled={lines.length === 1}
                className="rounded-lg border border-slate-300 px-3 py-2 text-slate-500 disabled:opacity-30 dark:border-slate-700"
              >
                ✕
              </button>
            </div>
          ))}
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
