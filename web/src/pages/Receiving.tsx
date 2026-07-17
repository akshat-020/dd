import { useEffect, useState } from "react";
import { api, ApiError, qrImageUrl } from "../api/client";
import type { Location, Sku, SkuBatch } from "../api/types";
import { QrScannerModal } from "../components/QrScannerModal";
import { SkuCombobox } from "../components/SkuCombobox";
import { LabelPrintPanel } from "../components/LabelPrintPanel";
import { useAuth } from "../auth/AuthContext";
import { compoundBreakdown } from "../lib/units";

type ScannerTarget = "location" | "sku" | null;

export default function Receiving() {
  const { hasScanAccess, hasInwardEntryAccess } = useAuth();
  const [skus, setSkus] = useState<Sku[]>([]);
  const [skuId, setSkuId] = useState("");
  const [sourceType, setSourceType] = useState<"PURCHASE" | "PRODUCTION">("PURCHASE");
  const [receivedQuantity, setReceivedQuantity] = useState("");
  const [supplierRef, setSupplierRef] = useState("");
  const [note, setNote] = useState("");
  const [batch, setBatch] = useState<SkuBatch | null>(null);
  const [pendingBatches, setPendingBatches] = useState<SkuBatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Putaway state, once a batch is active
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [skuLabelConfirmed, setSkuLabelConfirmed] = useState(false);
  const [qty, setQty] = useState("");

  useEffect(() => {
    if (hasInwardEntryAccess) api.get<Sku[]>("/skus").then(setSkus).catch(() => {});
  }, [hasInwardEntryAccess]);

  // Someone who can shelve but didn't log the batch themselves (typically
  // Warehouse, who no longer has inward-entry access) needs a way to find a
  // batch that Owner/Sales already logged, rather than only ever handling
  // one they just created in the same session.
  useEffect(() => {
    if (hasScanAccess && !batch) {
      api
        .get<SkuBatch[]>("/stock/batches/recent")
        .then(setPendingBatches)
        .catch(() => {});
    }
  }, [hasScanAccess, batch]);

  const activeSku = batch?.sku ?? skus.find((s) => s.id === batch?.skuId);
  // A just-created batch has nothing shelved yet, so falls back to its full
  // declared quantity; a batch picked from "recent" already carries the
  // computed remainder. Null means "no declared quantity to compare
  // against" (legacy batch) — no cap to show.
  const remainingToShelve = batch ? batch.remainingToShelve ?? batch.receivedQuantity ?? null : null;

  async function handleCreateBatch(e: React.FormEvent) {
    e.preventDefault();
    if (!skuId || !receivedQuantity) return;
    setError(null);
    setSubmitting(true);
    try {
      const b = await api.post<SkuBatch>("/stock/batches", {
        skuId,
        sourceType,
        receivedQuantity: Number(receivedQuantity),
        supplierRef: supplierRef || undefined,
        note: note || undefined,
      });
      setBatch(b);
      setLocation(null);
      setSkuLabelConfirmed(false);
      setReceivedQuantity("");
      setSupplierRef("");
      setNote("");
      setNotice("Batch logged. Print the label below, then assign it to a location.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to log batch");
    } finally {
      setSubmitting(false);
    }
  }

  function handleScanLocation(text: string) {
    setScannerTarget(null);
    api
      .get<Location>(`/locations/by-code/${encodeURIComponent(text)}`)
      .then((loc) => {
        setLocation(loc);
        setError(null);
      })
      .catch(() => setError(`No location found for code "${text}"`));
  }

  function handleScanSkuLabel(text: string) {
    setScannerTarget(null);
    if (!batch || !activeSku) return;
    // A camera scan yields the full encoded label ("SKU:x|BATCH:y|DATE:z"),
    // so both SKU and batch are checked. Manual entry realistically only
    // ever contains the bare SKU code (no one types the batch code from
    // memory), so fall back to a SKU-only check in that case.
    const skuMatch = /SKU:([^|]+)/.exec(text);
    const batchMatch = /BATCH:([^|]+)/.exec(text);
    const scannedSku = skuMatch ? skuMatch[1] : text;
    if (scannedSku !== activeSku.code || (skuMatch && batchMatch?.[1] !== batch.batchCode)) {
      setError("Scanned label doesn't match the batch you're putting away.");
      return;
    }
    setSkuLabelConfirmed(true);
    setError(null);
  }

  async function handlePutaway(e: React.FormEvent) {
    e.preventDefault();
    if (!batch || !location) return;
    const quantity = Number(qty);
    if (quantity <= 0) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/stock/putaway", { skuId: batch.skuId, locationId: location.id, batchId: batch.id, quantity });
      const compound = activeSku ? compoundBreakdown(quantity, activeSku) : null;
      setNotice(
        `Placed ${quantity}${compound ? ` (${compound})` : ""} at ${location.code}. Pick another batch, or log a new one.`
      );
      setBatch(null);
      setLocation(null);
      setSkuLabelConfirmed(false);
      setQty("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Putaway failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Receiving</h1>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      {hasInwardEntryAccess && (
        <form onSubmit={handleCreateBatch} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Log a new inward entry</h2>
          <SkuCombobox skus={skus} value={skuId} onChange={setSkuId} />
          <div className="flex gap-2">
            {(["PURCHASE", "PRODUCTION"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSourceType(t)}
                className={`flex-1 rounded-lg border px-3 py-3 text-sm font-medium ${
                  sourceType === t
                    ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                    : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"
                }`}
              >
                {t === "PURCHASE" ? "Purchase" : "Production"}
              </button>
            ))}
          </div>
          <input
            type="number"
            min={1}
            required
            value={receivedQuantity}
            onChange={(e) => setReceivedQuantity(e.target.value)}
            placeholder="Quantity received"
            className="w-full rounded-lg border border-slate-300 px-3 py-3 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <input
            value={supplierRef}
            onChange={(e) => setSupplierRef(e.target.value)}
            placeholder="Supplier / PO reference (optional)"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          />
          <button type="submit" disabled={submitting} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900">
            {submitting ? "Logging…" : "Log entry & generate label"}
          </button>
          <p className="text-xs text-slate-400">
            What this cost is entered separately by Owner/Accountant, linked to this batch — not part of this form.
          </p>
        </form>
      )}

      {hasScanAccess && !batch && pendingBatches.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="mb-2 text-sm font-semibold text-slate-900 dark:text-slate-50">Pick a batch to shelve</h2>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {pendingBatches.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => setBatch(b)}
                  className="flex w-full items-center justify-between py-2 text-left text-sm"
                >
                  <span>
                    <span className="font-mono font-semibold">{b.sku?.code}</span>
                    <span className="text-slate-400"> · {b.batchCode}</span>
                    {b.remainingToShelve != null && (
                      <span className="ml-2 text-xs text-slate-400">{b.remainingToShelve} left to shelve</span>
                    )}
                  </span>
                  <span className="text-xs text-slate-400">{new Date(b.receivedDate).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {batch && activeSku && (
        <div className="space-y-4">
          {/* Not `print:hidden` as a whole — LabelPrintPanel below renders
              its own isolated print-only output as a sibling of its
              on-screen controls, and that must not sit under a
              display:none ancestor or it would never print either. */}
          <div className="flex flex-col items-center rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <img src={qrImageUrl("batch", batch.id)} alt={batch.batchCode} className="h-40 w-40 print:hidden" />
            <div className="mt-2 text-center font-mono text-sm font-semibold print:hidden">{activeSku.code} · {batch.batchCode}</div>
            <div className="mt-2 flex items-center gap-2">
              <LabelPrintPanel
                triggerLabel="Print label"
                labels={[
                  {
                    id: batch.id,
                    qrUrl: qrImageUrl("batch", batch.id),
                    primary: activeSku.code,
                    secondary: [batch.batchCode, new Date(batch.receivedDate).toLocaleDateString()],
                  },
                ]}
              />
              {hasScanAccess && (
                <button onClick={() => setBatch(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm dark:border-slate-700">
                  Choose different batch
                </button>
              )}
            </div>
          </div>

          {hasScanAccess ? (
            <form onSubmit={handlePutaway} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Assign to a location</h2>

              <button
                type="button"
                onClick={() => setScannerTarget("location")}
                className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium dark:border-slate-700"
              >
                {location ? `Location: ${location.code} (rescan)` : "Scan destination location"}
              </button>

              {location && (
                <button
                  type="button"
                  onClick={() => setScannerTarget("sku")}
                  className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium dark:border-slate-700"
                >
                  {skuLabelConfirmed ? "Item label confirmed ✓" : "Scan item label to confirm"}
                </button>
              )}

              {location && skuLabelConfirmed && (
                <>
                  {remainingToShelve != null && (
                    <p className="text-center text-xs text-slate-400">{remainingToShelve} remaining to shelve for this batch</p>
                  )}
                  <input
                    type="number"
                    min={1}
                    max={remainingToShelve ?? undefined}
                    required
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                    placeholder="Quantity"
                    className="w-full rounded-lg border border-slate-300 px-4 py-3 text-center text-xl font-bold outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />
                  <button type="submit" disabled={submitting} className="w-full rounded-lg bg-green-600 px-4 py-3 font-semibold text-white disabled:opacity-50">
                    {submitting ? "Saving…" : "Confirm putaway"}
                  </button>
                </>
              )}
            </form>
          ) : (
            <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              Batch logged and labeled. Placing it into a location requires the scan-based putaway
              permission — hand the printed label to a warehouse team member to shelve it.
            </p>
          )}
        </div>
      )}

      {!hasInwardEntryAccess && !hasScanAccess && (
        <p className="text-sm text-slate-500 dark:text-slate-400">You don't have inward-entry or putaway access on this account.</p>
      )}

      {scannerTarget && (
        <QrScannerModal
          title={scannerTarget === "location" ? "Scan location QR" : "Scan item label"}
          onDecode={scannerTarget === "location" ? handleScanLocation : handleScanSkuLabel}
          onClose={() => setScannerTarget(null)}
        />
      )}
    </div>
  );
}
