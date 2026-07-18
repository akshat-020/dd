import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { InvoiceReference, Order } from "../api/types";

interface PricingLine {
  lineId: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  qty: number; // base unit — canonical
  // How this line was actually placed (e.g. "5 Box") — null means base unit.
  // Price applies per 1 of this unit, not the base unit.
  unit: string | null;
  unitQty: number | null;
  unitPrice: number | null;
  // The SKU's Default Price (MRP) for this same unit — a prefill hint only,
  // never applied automatically. Null if the SKU has none set for this unit.
  defaultUnitPrice: number | null;
}

export default function Pricing() {
  const { hasPermission, hasAllPermissions } = useAuth();
  // Saving the order's canonical price is a shared write behind both
  // financial document types — the server requires both permissions (see
  // requireAllPermissions in routes/pricing.ts), so the form that writes it
  // only shows for an account holding both, not just one.
  const canSavePricing = hasAllPermissions("pricing.manageInvoiceReference", "pricing.managePI");

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
      // Prefill from the SKU's Default Price when nothing's been explicitly
      // set yet — still just a starting point, freely overridable, and
      // "Save pricing" is what actually commits whatever's shown.
      setPrices(
        Object.fromEntries(
          res.lines.map((l) => {
            const prefill = l.unitPrice ?? l.defaultUnitPrice;
            return [l.lineId, prefill != null ? String(prefill) : ""];
          })
        )
      );
      // Whole endpoint is gated on pricing.manageInvoiceReference — skip the
      // call entirely for an account that doesn't hold it (e.g. PI-only)
      // rather than surfacing its 403 as a scary top-level error banner for
      // a perfectly normal, permitted state.
      if (hasPermission("pricing.manageInvoiceReference")) {
        const refs = await api.get<InvoiceReference[]>(`/invoice-references/order/${orderId}`);
        setInvoiceRefs(refs);
      } else {
        setInvoiceRefs([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load pricing");
    }
  }, [orderId, hasPermission]);

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
        // Bill in whichever unit the order line was placed in — qty here
        // is in that unit (unitQty), not the base-unit qty, since price was
        // set per 1 of that unit.
        lines: lines.map((l) => ({
          skuId: l.skuId,
          qty: l.unitQty ?? l.qty,
          unit: l.unit ?? undefined,
          price: Number(prices[l.lineId]),
        })),
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
    if (busy) return;
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
    if (busy) return;
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
          {/* These inputs stay editable for anyone reaching this screen — the
              value typed here also feeds "Add Invoice Reference" below,
              which is independently gated on pricing.manageInvoiceReference
              at its own endpoint and doesn't depend on "Save pricing"
              succeeding. Only persisting this as the order's shared
              canonical price (the button below) needs both permissions. */}
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500 dark:text-slate-400">
              <tr>
                <th className="py-1">SKU</th>
                <th className="py-1">Qty</th>
                <th className="py-1">Price (per unit shown)</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.lineId}>
                  <td className="py-1">{l.skuCode}</td>
                  <td className="py-1">
                    {l.unit ? `${l.unitQty} ${l.unit}` : l.qty}
                    {l.unit && <span className="ml-1 text-xs text-slate-400">({l.qty} base)</span>}
                  </td>
                  <td className="py-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={prices[l.lineId] ?? ""}
                      onChange={(e) => setPrices({ ...prices, [l.lineId]: e.target.value })}
                      className="w-28 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                    />
                    {l.unitPrice == null && l.defaultUnitPrice != null && (
                      <span className="ml-1 text-xs text-slate-400" title="Prefilled from this SKU's Default Price (MRP) — not yet saved">
                        (default)
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {canSavePricing ? (
            <button type="submit" disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
              {busy ? "Saving…" : "Save pricing"}
            </button>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Saving this as the order's stored price requires both the Invoice Reference and Proforma Invoice permissions. You can still use the price
              typed above for whichever document you're permitted to create below.
            </p>
          )}
        </form>
      )}

      {orderId && hasPermission("pricing.manageInvoiceReference") && (
        <form onSubmit={handleAddInvoiceReference} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Add Invoice Reference (Tally)</h2>
          <div className="flex gap-2">
            <input
              value={tallyNumber}
              disabled={busy}
              onChange={(e) => setTallyNumber(e.target.value)}
              placeholder="Tally invoice number"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <button type="submit" disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
              {busy ? "Adding…" : "Add"}
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
                      {l.sku?.code ?? l.skuId} · {l.qty} {l.unit ?? l.sku?.unit ?? ""} × ₹{l.price}
                    </span>
                    {ref.status !== "CANCELLED" && (
                      <button onClick={() => handleAdjust(ref.id, l.id, l.qty, l.price)} disabled={busy} className="text-xs underline disabled:opacity-50">
                        {busy ? "Working…" : "Adjust"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {ref.status !== "CANCELLED" && (
                <button
                  onClick={() => handleCancel(ref.id)}
                  disabled={busy}
                  className="mt-3 rounded-lg border border-red-300 px-3 py-1 text-xs font-medium text-red-600 disabled:opacity-50 dark:border-red-800 dark:text-red-400"
                >
                  {busy ? "Working…" : "Cancel invoice reference"}
                </button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
