import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Location, PutBackTask } from "../api/types";
import { QrScannerModal } from "../components/QrScannerModal";
import { compoundBreakdown } from "../lib/units";

// Round 4 #4: post-pick adjustment ("put-back"). When a Final Qty edit
// drops below what's already been picked, the server queues a PutBackTask
// (see reconcileOrderLineAllocation) instead of silently dropping the
// difference or double-counting it as available. This screen is where the
// warehouse confirms the physical return — same scan-based confirm pattern
// as putaway — which is the only point stock actually moves back onto the
// shelf and the order's picked-quantity record reconciles to match.
export default function PutBacks() {
  const [tasks, setTasks] = useState<PutBackTask[]>([]);
  const [active, setActive] = useState<PutBackTask | null>(null);
  const [scanning, setScanning] = useState(false);
  const [destination, setDestination] = useState<Location | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api
      .get<PutBackTask[]>("/put-backs")
      .then(setTasks)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load put-back tasks"));
  }

  useEffect(load, []);

  function handleScanDestination(text: string) {
    setScanning(false);
    api
      .get<Location>(`/locations/by-code/${encodeURIComponent(text)}`)
      .then((loc) => {
        setDestination(loc);
        setError(null);
      })
      .catch(() => setError(`No location found for code "${text}"`));
  }

  async function handleConfirm() {
    if (!active) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/put-backs/${active.id}/confirm`, destination ? { locationId: destination.id } : {});
      const compound = compoundBreakdown(active.quantity, active.sku);
      setNotice(
        `Returned ${active.quantity}${compound ? ` (${compound})` : ""} of ${active.sku.code} to ${destination?.code ?? active.fromLocation.code}.`
      );
      setActive(null);
      setDestination(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to confirm put-back");
    } finally {
      setSubmitting(false);
    }
  }

  if (active) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Confirm put-back</h1>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Order {active.order.orderNumber} · {active.order.buyerName}
          </p>
          <p className="text-2xl font-bold text-slate-900 dark:text-slate-50">
            {active.sku.code} × {active.quantity}
            {compoundBreakdown(active.quantity, active.sku) && (
              <span className="ml-1 text-sm font-normal text-slate-400">({compoundBreakdown(active.quantity, active.sku)})</span>
            )}
          </p>
          <p className="text-xs text-slate-400">{active.sku.name}</p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Originally picked from <span className="font-mono">{active.fromLocation.code}</span> — return there, or scan a
            different location if the original spot is unavailable.
          </p>

          <button
            type="button"
            onClick={() => setScanning(true)}
            className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium dark:border-slate-700"
          >
            {destination ? `Return to: ${destination.code} (rescan)` : `Scan return location (default: ${active.fromLocation.code})`}
          </button>

          <div className="flex gap-2">
            <button
              onClick={handleConfirm}
              disabled={submitting}
              className="flex-1 rounded-lg bg-green-600 px-4 py-3 font-semibold text-white disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Confirm return"}
            </button>
            <button
              type="button"
              onClick={() => {
                setActive(null);
                setDestination(null);
                setError(null);
              }}
              className="rounded-lg border border-slate-300 px-4 py-3 text-sm dark:border-slate-700"
            >
              Back
            </button>
          </div>
        </div>

        {scanning && (
          <QrScannerModal title="Scan return location" onDecode={handleScanDestination} onClose={() => setScanning(false)} />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Put-backs</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Stock already picked for an order, no longer needed at the reduced Final Qty — pending return to inventory.
      </p>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      {tasks.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing pending.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {tasks.map((t) => (
            <li key={t.id}>
              <button onClick={() => setActive(t)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm">
                <span>
                  <span className="font-mono font-semibold">{t.sku.code}</span> × {t.quantity}
                  <span className="ml-2 text-xs text-slate-400">from {t.fromLocation.code}</span>
                  <div className="text-xs text-slate-400">
                    {t.order.orderNumber} · {t.order.buyerName}
                  </div>
                </span>
                <span className="text-xs text-slate-400">{new Date(t.createdAt).toLocaleDateString()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
