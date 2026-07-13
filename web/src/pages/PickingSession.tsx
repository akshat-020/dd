import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { PickListItem } from "../api/types";
import { db } from "../offline/db";
import { enqueueAction, flushQueue, onQueueChange, pendingCount } from "../offline/queue";
import { QrScannerModal } from "../components/QrScannerModal";

type ScannerTarget = "location" | "sku" | null;

export default function PickingSession() {
  const { orderId } = useParams<{ orderId: string }>();
  const [items, setItems] = useState<PickListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [qty, setQty] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(0);

  const refreshPending = useCallback(() => {
    pendingCount().then(setPending);
  }, []);

  const loadFromServer = useCallback(async () => {
    if (!orderId) return;
    try {
      const fresh = await api.get<PickListItem[]>(`/picking/orders/${orderId}`);
      setItems(fresh);
      await db.pickLists.put({ orderId, items: fresh, updatedAt: Date.now() });
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load pick list");
    }
  }, [orderId]);

  useEffect(() => {
    if (!orderId) return;
    // Load cached data first so the screen renders instantly even offline,
    // then refresh from the server if reachable.
    db.pickLists.get(orderId).then((cached) => {
      if (cached) setItems(cached.items);
    });
    if (navigator.onLine) loadFromServer();
    refreshPending();
  }, [orderId, loadFromServer, refreshPending]);

  useEffect(() => {
    const unsub = onQueueChange(refreshPending);
    const onOnline = () => {
      setOnline(true);
      flushQueue().then(loadFromServer);
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      unsub();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [loadFromServer, refreshPending]);

  const currentItem = useMemo(() => {
    const sorted = [...items].sort((a, b) => a.sequence - b.sequence);
    return sorted.find((i) => i.status !== "PICKED") ?? null;
  }, [items]);

  function updateLocal(itemId: string, patch: Partial<PickListItem>) {
    setItems((prev) => {
      const next = prev.map((i) => (i.id === itemId ? { ...i, ...patch } : i));
      if (orderId) db.pickLists.put({ orderId, items: next, updatedAt: Date.now() });
      return next;
    });
  }

  async function handleScanLocation(text: string) {
    if (!currentItem) return;
    setScannerTarget(null);
    if (text !== currentItem.location.code) {
      setError(`Wrong location — expected ${currentItem.location.code}, scanned ${text}`);
      return;
    }
    setError(null);
    if (navigator.onLine) {
      try {
        await api.post(`/picking/items/${currentItem.id}/scan-location`, { locationCode: text });
        updateLocal(currentItem.id, { status: "LOCATION_CONFIRMED" });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Scan failed");
      }
    } else {
      updateLocal(currentItem.id, { status: "LOCATION_CONFIRMED" });
      await enqueueAction({
        type: "scan-location",
        path: `/picking/items/${currentItem.id}/scan-location`,
        payload: { locationCode: text },
        orderId,
        itemId: currentItem.id,
      });
    }
  }

  async function handleScanSku(text: string) {
    if (!currentItem) return;
    setScannerTarget(null);
    const skuMatch = /SKU:([^|]+)/.exec(text);
    const scannedCode = skuMatch ? skuMatch[1] : text;
    if (scannedCode !== currentItem.sku.code) {
      setError(`Wrong item — expected ${currentItem.sku.code}, scanned ${scannedCode}`);
      return;
    }
    setError(null);
    if (navigator.onLine) {
      try {
        await api.post(`/picking/items/${currentItem.id}/scan-sku`, { label: text });
        updateLocal(currentItem.id, { status: "SKU_CONFIRMED" });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Scan failed");
      }
    } else {
      updateLocal(currentItem.id, { status: "SKU_CONFIRMED" });
      await enqueueAction({
        type: "scan-sku",
        path: `/picking/items/${currentItem.id}/scan-sku`,
        payload: { label: text },
        orderId,
        itemId: currentItem.id,
      });
    }
  }

  async function handleConfirm() {
    if (!currentItem) return;
    const quantity = Number(qty || currentItem.qtyToPick);
    if (quantity <= 0 || quantity > currentItem.qtyToPick) {
      setError(`Quantity must be between 1 and ${currentItem.qtyToPick}`);
      return;
    }
    setError(null);
    setQty("");
    if (navigator.onLine) {
      try {
        await api.post(`/picking/items/${currentItem.id}/confirm`, { quantity });
        loadFromServer();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Confirm failed");
      }
    } else {
      updateLocal(currentItem.id, { status: "PICKED", qtyPicked: quantity });
      await enqueueAction({
        type: "confirm-pick",
        path: `/picking/items/${currentItem.id}/confirm`,
        payload: { quantity },
        orderId,
        itemId: currentItem.id,
      });
    }
  }

  const allPicked = items.length > 0 && items.every((i) => i.status === "PICKED");

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Picking</h1>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${online ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}`}>
          {online ? "Online" : "Offline"}
        </span>
      </div>

      {pending > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {pending} action{pending === 1 ? "" : "s"} waiting to sync{online ? "…" : " (will sync when back online)"}
        </p>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {allPicked && (
        <p className="rounded-lg bg-green-50 px-4 py-3 text-center text-sm font-medium text-green-700 dark:bg-green-950 dark:text-green-300">
          All items picked. {pending > 0 ? "Waiting to sync…" : "Order loaded."}
        </p>
      )}

      {currentItem && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-1 text-xs font-medium text-slate-400">Item {currentItem.sequence} of {items.length}</div>
          <div className="mb-1 text-2xl font-bold text-slate-900 dark:text-slate-50">{currentItem.sku.code}</div>
          <div className="mb-4 text-sm text-slate-500 dark:text-slate-400">{currentItem.sku.name}</div>

          {currentItem.isShortfallFollowup && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
              {currentItem.note ?? "Follow-up task from an earlier shortfall."}
            </p>
          )}

          <div className="mb-4 rounded-xl bg-slate-100 p-4 text-center dark:bg-slate-800">
            <div className="text-xs uppercase text-slate-500 dark:text-slate-400">Go to location</div>
            <div className="text-3xl font-bold tracking-wide text-slate-900 dark:text-slate-50">{currentItem.location.code}</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Pick {currentItem.qtyToPick} {currentItem.sku.unit}</div>
          </div>

          {currentItem.status === "PENDING" && (
            <button
              onClick={() => setScannerTarget("location")}
              className="w-full rounded-xl bg-slate-900 px-4 py-4 text-lg font-semibold text-white dark:bg-slate-100 dark:text-slate-900"
            >
              Scan location
            </button>
          )}

          {currentItem.status === "LOCATION_CONFIRMED" && (
            <button
              onClick={() => setScannerTarget("sku")}
              className="w-full rounded-xl bg-slate-900 px-4 py-4 text-lg font-semibold text-white dark:bg-slate-100 dark:text-slate-900"
            >
              Scan item label
            </button>
          )}

          {currentItem.status === "SKU_CONFIRMED" && (
            <div className="space-y-2">
              <input
                type="number"
                min={1}
                max={currentItem.qtyToPick}
                placeholder={String(currentItem.qtyToPick)}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-4 py-4 text-center text-2xl font-bold outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button onClick={handleConfirm} className="w-full rounded-xl bg-green-600 px-4 py-4 text-lg font-semibold text-white">
                Confirm pick
              </button>
            </div>
          )}
        </div>
      )}

      {scannerTarget && (
        <QrScannerModal
          title={scannerTarget === "location" ? "Scan location QR" : "Scan item label"}
          onDecode={scannerTarget === "location" ? handleScanLocation : handleScanSku}
          onClose={() => setScannerTarget(null)}
        />
      )}

      <ul className="space-y-1">
        {[...items]
          .sort((a, b) => a.sequence - b.sequence)
          .map((i) => (
            <li key={i.id} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm dark:bg-slate-900">
              <span className={i.status === "PICKED" ? "text-slate-400 line-through" : "text-slate-700 dark:text-slate-300"}>
                {i.location.code} · {i.sku.code} × {i.qtyToPick}
              </span>
              <span className="text-xs text-slate-400">{i.status}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}
