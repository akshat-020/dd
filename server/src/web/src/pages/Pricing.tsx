import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { InvoiceReference, Order } from "../api/types";

interface PricingLine {
  lineId: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  qty: number;
  unitPrice: number | null;
}

export default function Pricing() {
  const [searchParams, setSearchParams] = useSearchParams();
  const orderId = searchParams.get("order") ?? "";

  const [orders, setOrders] = useState<Order[]>([]);
  const [lines, setLines] = useState<PricingLine[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [invoiceRefs, setInvoiceRefs] = useState<InvoiceReference[]>([]);
  const [tallyNumber, setTallyNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Order[]>("/orders")
      .then((all) => setOrders(all.filter((o) => o.status !== "DRAFT" && o.status !== "CANCELLED")))
      .catch(() => {});
  }, []);

  const loadPricing = useCallback(async () => {
    if (!orderId) return;
    try {
      const res = await api.get<{ lines: PricingLine[] }>(`/orders/${orderId}/pricing`);
      setLines(res.lines);
      setPrices(Object.fromEntries(res.lines.map((l) => [l.lineId, l.unitPrice != null ? String(l.unitPrice) : ""])));
      const refs = await api.get<InvoiceReference[]>(`/invoice-references/order/${orderId}`);
      setInvoiceRefs(refs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load pricing");
    }
  }, [orderId]);

  useEffect(() => {
    loadPricing();
  }, [loadPricing]);

  async function handleSavePricing(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put(`/orders/${orderId}/pricing`, {
        lines: lines.map((l) => ({ lineId: l.lineId, unitPrice: Number(prices[l.lineId] || 0) })),
      });
      setNotice("Pricing saved.");
      loadPricing();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save pricing");
    } finally {
      setBusy(false);
    }
  }

  async function handleAddInvoiceReference(e: React.FormEvent) {
    e.preventDefault();
    if (!tallyNumber) return;
    const unpriced = lines.filter((l) => prices[l.lineId] == null || prices[l.lineId] === "");
    if (unpriced.length > 0) {
      setError("Set a price for every line before creating the invoice reference.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/invoice-references", {
        tallyInvoiceNumber: tallyNumber,
        orderId,
        lines: lines.map((l) => ({ skuId: l.skuId, qty: l.qty, price: Number(prices[l.lineId]) })),
      });
      setTallyNumber("");
      setNotice("Invoice reference added.");
      loadPricing();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add invoice reference");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(refId: string) {
    const reverseStock = confirm("Were goods actually returned? OK = reverse stock, Cancel = paperwork-only void.");
    setBusy(true);
    setError(null);
    try {
      await api.post(`/invoice-references/${refId}/cancel`, { reverseStock });
      loadPricing();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to cancel invoice reference");
    } finally {
      setBusy(false);
    }
  }

  async function handleAdjust(refId: string, lineId: string, currentQty: number, currentPrice: number) {
    const qtyStr = prompt("New quantity", String(currentQty));
    if (qtyStr === null) return;
    const priceStr = prompt("New price", String(currentPrice));
    if (priceStr === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/invoice-references/${refId}/adjust`, {
        lines: [{ invoiceLineId: lineId, qty: Number(qtyStr), price: Number(priceStr) }],
      });
      setNotice("Invoice reference adjusted; stock movement recorded.");
      loadPricing();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to adjust invoice reference");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Pricing & Invoice Reference</h1>

      <select
        value={orderId}
        onChange={(e) => setSearchParams(e.target.value ? { order: e.target.value } : {})}
        className="w-full rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      >
        <option value="">Select an order…</option>
        {orders.map((o) => (
          <option key={o.id} value={o.id}>
            {o.orderNumber} — {o.buyerName} ({o.status})
          </option>
        ))}
      </select>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      {orderId && lines.length > 0 && (
        <form onSubmit={handleSavePricing} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Line pricing</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-1">SKU</th>
                <th className="py-1">Qty</th>
                <th className="py-1">Unit price</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineId}>
                  <td className="py-1">{l.skuCode}</td>
                  <td className="py-1">{l.qty}</td>
                  <td className="py-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={prices[l.lineId] ?? ""}
                      onChange={(e) => setPrices({ ...prices, [l.lineId]: e.target.value })}
                      className="w-28 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="submit" disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            Save pricing
          </button>
        </form>
      )}

      {orderId && (
        <form onSubmit={handleAddInvoiceReference} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Add Invoice Reference (Tally)</h2>
          <div className="flex gap-2">
            <input
              value={tallyNumber}
              onChange={(e) => setTallyNumber(e.target.value)}
              placeholder="Tally invoice number"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <button type="submit" disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
              Add
            </button>
          </div>
        </form>
      )}

      {orderId && invoiceRefs.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Invoice references</h2>
          {invoiceRefs.map((ref) => (
            <div key={ref.id} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <div className="font-medium text-slate-900 dark:text-slate-50">{ref.tallyInvoiceNumber}</div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    ref.status === "CANCELLED"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                      : ref.status === "ADJUSTED"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                        : "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                  }`}
                >
                  {ref.status}
                </span>
              </div>
              <ul className="mt-2 space-y-1 text-sm text-slate-600 dark:text-slate-300">
                {ref.lines.map((l) => (
                  <li key={l.id} className="flex items-center justify-between">
                    <span>
                      {l.sku?.code ?? l.skuId} · {l.qty} × ₹{l.price}
                    </span>
                    {ref.status !== "CANCELLED" && (
                      <button onClick={() => handleAdjust(ref.id, l.id, l.qty, l.price)} className="text-xs underline">
                        Adjust
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {ref.status !== "CANCELLED" && (
                <button onClick={() => handleCancel(ref.id)} className="mt-3 rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-600 dark:border-red-800 dark:text-red-400">
                  Cancel invoice reference
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
