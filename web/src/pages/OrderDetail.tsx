import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { SkuCombobox } from "../components/SkuCombobox";
import type { Order, PickListItem, Sku, StockCheckResult } from "../api/types";

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { hasRole } = useAuth();
  const canEdit = hasRole("OWNER", "SALES");
  const canSeePrice = hasRole("OWNER", "ACCOUNTANT");

  const [order, setOrder] = useState<Order | null>(null);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [stockCheck, setStockCheck] = useState<StockCheckResult[]>([]);
  const [pickList, setPickList] = useState<PickListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Editable order-header fields (buyer/vehicle note) — separate local state
  // so typing isn't clobbered by the periodic `load()` refresh, only reset
  // when a different order is loaded.
  const [headerDraft, setHeaderDraft] = useState({ buyerName: "", buyerContact: "", vehicleCapacityNote: "" });
  const [editingHeader, setEditingHeader] = useState(false);
  const [addItemSkuId, setAddItemSkuId] = useState("");

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const o = await api.get<Order>(`/orders/${id}`);
      setOrder(o);
      if (o.status === "DRAFT") {
        const check = await api.get<StockCheckResult[]>(`/orders/${id}/stock-check`);
        setStockCheck(check);
      } else {
        const pl = await api.get<PickListItem[]>(`/picking/orders/${id}`);
        setPickList(pl);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load order");
    }
  }, [id]);

  useEffect(() => {
    load();
    api.get<Sku[]>("/skus").then(setSkus).catch(() => {});
  }, [load]);

  useEffect(() => {
    if (order) {
      setHeaderDraft({
        buyerName: order.buyerName,
        buyerContact: order.buyerContact ?? "",
        vehicleCapacityNote: order.vehicleCapacityNote ?? "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  if (!order) return <p className="text-sm text-slate-500 dark:text-slate-400">{error ?? "Loading…"}</p>;

  const isDraft = order.status === "DRAFT";

  async function updateLineQty(lineId: string, qtyRequested: number) {
    await api.patch(`/orders/${id}`, { lines: [{ id: lineId, qtyRequested }] });
    load();
  }

  async function removeLine(lineId: string) {
    await api.patch(`/orders/${id}`, { lines: [{ id: lineId, remove: true }] });
    load();
  }

  async function addLine(skuId: string) {
    if (!skuId) return;
    await api.patch(`/orders/${id}`, { lines: [{ skuId, qtyRequested: 1 }] });
    load();
  }

  async function saveHeader() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/orders/${id}`, {
        buyerName: headerDraft.buyerName,
        buyerContact: headerDraft.buyerContact,
        vehicleCapacityNote: headerDraft.vehicleCapacityNote,
      });
      setEditingHeader(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save order details");
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalize() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/orders/${id}/finalize`);
      setNotice("Order finalized — pick list generated.");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const shortfalls = err.body?.shortfalls;
        setError(`${err.message}${shortfalls ? ": " + JSON.stringify(shortfalls) : ""}`);
      } else {
        setError(err instanceof ApiError ? err.message : "Finalize failed");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!confirm("Cancel this order?")) return;
    setBusy(true);
    try {
      await api.post(`/orders/${id}/cancel`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Cancel failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">{order.orderNumber}</h1>
          {!editingHeader && (
            <p className="text-sm text-slate-500 dark:text-slate-400">{order.buyerName}{order.buyerContact ? ` · ${order.buyerContact}` : ""}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">{order.status}</span>
          {isDraft && canEdit && !editingHeader && (
            <button onClick={() => setEditingHeader(true)} className="text-xs font-medium text-slate-500 underline dark:text-slate-400">
              Edit details
            </button>
          )}
        </div>
      </div>

      {isDraft && canEdit && editingHeader ? (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Buyer name</span>
              <input
                value={headerDraft.buyerName}
                onChange={(e) => setHeaderDraft({ ...headerDraft, buyerName: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Contact</span>
              <input
                value={headerDraft.buyerContact}
                onChange={(e) => setHeaderDraft({ ...headerDraft, buyerContact: e.target.value })}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">Vehicle / load note</span>
            <input
              value={headerDraft.vehicleCapacityNote}
              onChange={(e) => setHeaderDraft({ ...headerDraft, vehicleCapacityNote: e.target.value })}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
          </label>
          <div className="flex gap-2">
            <button onClick={saveHeader} disabled={busy} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
              Save
            </button>
            <button
              onClick={() => {
                setEditingHeader(false);
                setHeaderDraft({ buyerName: order.buyerName, buyerContact: order.buyerContact ?? "", vehicleCapacityNote: order.vehicleCapacityNote ?? "" });
              }}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        order.vehicleCapacityNote && (
          <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            Vehicle note: {order.vehicleCapacityNote}
          </p>
        )
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2">SKU</th>
              <th className="px-4 py-2">Requested</th>
              {!isDraft && <th className="px-4 py-2">Finalized</th>}
              {!isDraft && <th className="px-4 py-2">Picked</th>}
              {isDraft && <th className="px-4 py-2">Available</th>}
              {canSeePrice && !isDraft && <th className="px-4 py-2">Unit price</th>}
              {isDraft && canEdit && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {order.lines.map((line) => {
              const check = stockCheck.find((c) => c.lineId === line.id);
              return (
                <tr key={line.id}>
                  <td className="px-4 py-2">
                    {line.sku.code}
                    <div className="text-xs text-slate-400">{line.sku.name}</div>
                  </td>
                  <td className="px-4 py-2">
                    {isDraft && canEdit ? (
                      <input
                        type="number"
                        min={1}
                        defaultValue={line.qtyRequested}
                        onBlur={(e) => {
                          const v = Number(e.target.value);
                          if (v > 0 && v !== line.qtyRequested) updateLineQty(line.id, v);
                        }}
                        className="w-20 rounded border border-slate-300 px-2 py-1 dark:border-slate-700 dark:bg-slate-800"
                      />
                    ) : (
                      line.qtyRequested
                    )}
                  </td>
                  {!isDraft && <td className="px-4 py-2">{line.qtyFinalized ?? "—"}</td>}
                  {!isDraft && <td className="px-4 py-2">{line.qtyPicked}</td>}
                  {isDraft && (
                    <td className={`px-4 py-2 ${check && !check.sufficient ? "text-red-600 dark:text-red-400" : ""}`}>
                      {check ? check.available : "…"}
                    </td>
                  )}
                  {canSeePrice && !isDraft && <td className="px-4 py-2">{line.unitPrice != null ? `₹${line.unitPrice}` : "—"}</td>}
                  {isDraft && canEdit && (
                    <td className="px-4 py-2">
                      <button onClick={() => removeLine(line.id)} className="text-slate-400 hover:text-red-600">
                        ✕
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {isDraft && canEdit && (
          <div className="border-t border-slate-200 p-3 dark:border-slate-800">
            <SkuCombobox
              skus={skus}
              value={addItemSkuId}
              onChange={(skuId) => {
                setAddItemSkuId(skuId);
                if (skuId) {
                  addLine(skuId);
                  setAddItemSkuId("");
                }
              }}
              placeholder="+ Add item… search by code or name"
            />
          </div>
        )}
      </div>

      {isDraft && canEdit && (
        <button onClick={handleFinalize} disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
          {busy ? "Finalizing…" : "Finalize order & generate pick list"}
        </button>
      )}

      {!isDraft && pickList.length > 0 && (
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900 dark:text-slate-50">Pick list</h2>
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {pickList.map((item) => (
              <li key={item.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>
                  #{item.sequence} · {item.location.code} · {item.sku.code} × {item.qtyToPick}
                </span>
                <span className={item.status === "PICKED" ? "text-green-600 dark:text-green-400" : "text-slate-400"}>{item.status}</span>
              </li>
            ))}
          </ul>
          {hasRole("OWNER", "WAREHOUSE") && (
            <Link to={`/picking/${id}`} className="mt-2 inline-block text-sm font-medium text-slate-600 underline dark:text-slate-300">
              Go to picking screen →
            </Link>
          )}
        </section>
      )}

      {canSeePrice && !isDraft && (
        <Link
          to={`/pricing?order=${id}`}
          className="block w-full rounded-lg border border-slate-300 px-4 py-3 text-center font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
        >
          Manage pricing & invoice reference →
        </Link>
      )}

      {hasRole("OWNER") && order.status !== "LOADED" && order.status !== "INVOICED" && order.status !== "CANCELLED" && (
        <button onClick={handleCancel} disabled={busy} className="w-full rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-600 dark:border-red-800 dark:text-red-400">
          Cancel order
        </button>
      )}
    </div>
  );
}
