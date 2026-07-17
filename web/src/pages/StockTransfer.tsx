import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Location, Sku } from "../api/types";
import { QrScannerModal } from "../components/QrScannerModal";
import { SkuCombobox } from "../components/SkuCombobox";

type ScannerTarget = "source" | "destination" | "item" | null;

interface BatchOption {
  batchId: string | null;
  batchCode: string | null;
  quantity: number;
}

// Round 4 #3: instant, single-warehouse rack-to-rack move. No "in transit"
// state — on confirm, stock is deducted from source and added to
// destination in one transaction (POST /stock/transfer), logged as its own
// movement type (TRANSFER_OUT/TRANSFER_IN), never Pick/Putaway. Available
// to Warehouse and to Sales accounts granted scan access, same gate as
// putaway/picking (see App.tsx route + requireScanAccess server-side).
export default function StockTransfer() {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [skuId, setSkuId] = useState("");
  const [batchId, setBatchId] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<Location | null>(null);
  const [destination, setDestination] = useState<Location | null>(null);
  const [batchOptions, setBatchOptions] = useState<BatchOption[]>([]);
  const [batchesLoaded, setBatchesLoaded] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [scannerTarget, setScannerTarget] = useState<ScannerTarget>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.get<Sku[]>("/skus").then(setSkus).catch(() => {});
  }, []);

  const activeSku = skus.find((s) => s.id === skuId);

  // Stock is tracked per batch — a location holding this SKU across several
  // batches has no meaningful "total" bucket to move from, so a specific
  // batch always has to be picked once both the SKU and source are known
  // (mirrors what /stock/transfer itself requires: an exact batchId, or
  // explicitly none). Re-fetches whenever either changes, and drops a
  // previously chosen/scanned batch if it turns out not to actually be at
  // this location.
  useEffect(() => {
    setBatchesLoaded(false);
    if (!skuId || !source) {
      setBatchOptions([]);
      return;
    }
    api
      .get<BatchOption[]>(`/stock/at-location/${source.id}/sku/${skuId}`)
      .then((rows) => {
        setBatchOptions(rows);
        setBatchesLoaded(true);
        setBatchId((current) => {
          if (rows.length === 1) return rows[0].batchId ?? undefined;
          if (current !== undefined && rows.some((r) => (r.batchId ?? undefined) === current)) return current;
          return undefined;
        });
      })
      .catch(() => {
        setBatchOptions([]);
        setBatchesLoaded(true);
      });
  }, [skuId, source]);

  const selectedBatch = batchOptions.find((b) => (b.batchId ?? undefined) === batchId);

  function handleScanLocation(text: string) {
    const target = scannerTarget;
    setScannerTarget(null);
    api
      .get<Location>(`/locations/by-code/${encodeURIComponent(text)}`)
      .then((loc) => {
        if (target === "source") setSource(loc);
        else if (target === "destination") setDestination(loc);
        setError(null);
      })
      .catch(() => setError(`No location found for code "${text}"`));
  }

  // Scanning the item label physically sitting at the source shelf pins
  // down both the SKU and the specific batch being moved — the same
  // "scan to confirm what's really there" pattern as putaway, rather than
  // trusting a manually-picked SKU to match reality. Still passes through
  // the batch-options fetch above once a source is also set, so a stale or
  // mismatched scan gets caught rather than silently trusted.
  function handleScanItem(text: string) {
    setScannerTarget(null);
    api
      .get<{ sku: Sku; batch: { id: string; batchCode: string } }>(`/stock/batches/resolve/${encodeURIComponent(text)}`)
      .then(({ sku, batch }) => {
        setSkuId(sku.id);
        setBatchId(batch.id);
        setError(null);
      })
      .catch(() => setError("Scanned label didn't match any known SKU/batch."));
  }

  async function handleTransfer(e: React.FormEvent) {
    e.preventDefault();
    if (!skuId || !source || !destination) return;
    const qty = Number(quantity);
    if (qty <= 0) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.post("/stock/transfer", {
        skuId,
        batchId,
        fromLocationId: source.id,
        toLocationId: destination.id,
        quantity: qty,
        reason: "Rack-to-rack transfer",
      });
      setNotice(`Moved ${qty} from ${source.code} to ${destination.code}.`);
      setSource(null);
      setDestination(null);
      setQuantity("");
      setBatchId(undefined);
      setBatchOptions([]);
      setSkuId("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Transfer failed");
    } finally {
      setSubmitting(false);
    }
  }

  const needsBatchChoice = batchesLoaded && batchOptions.length > 1;
  const readyForQuantity =
    source && destination && activeSku && batchesLoaded && batchOptions.length > 0 && (!needsBatchChoice || batchId !== undefined || batchOptions.some((b) => b.batchId == null));

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Transfer stock</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Move stock from one rack/bin to another within the same warehouse. Applied immediately — no in-transit state.
      </p>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      <form onSubmit={handleTransfer} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">SKU</span>
          <SkuCombobox
            skus={skus}
            value={skuId}
            onChange={(id) => {
              setSkuId(id);
              setBatchId(undefined);
            }}
          />
          <button
            type="button"
            onClick={() => setScannerTarget("item")}
            className="mt-1 text-xs font-medium text-slate-500 underline dark:text-slate-400"
          >
            or scan an item label instead
          </button>
        </div>

        <button
          type="button"
          onClick={() => setScannerTarget("source")}
          className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium dark:border-slate-700"
        >
          {source ? `Source: ${source.code} (rescan)` : "Scan/select source location"}
        </button>

        <button
          type="button"
          onClick={() => setScannerTarget("destination")}
          className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium dark:border-slate-700"
        >
          {destination ? `Destination: ${destination.code} (rescan)` : "Scan/select destination location"}
        </button>

        {source && destination && activeSku && source.id === destination.id && (
          <p className="text-xs text-red-600 dark:text-red-400">Source and destination must differ.</p>
        )}

        {source && activeSku && batchesLoaded && batchOptions.length === 0 && (
          <p className="text-xs text-red-600 dark:text-red-400">
            No stock of {activeSku.code} found at {source.code}.
          </p>
        )}

        {source && activeSku && needsBatchChoice && (
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-300">
              Multiple batches here — pick which one to move
            </span>
            <div className="space-y-1">
              {batchOptions.map((b) => (
                <label
                  key={b.batchId ?? "no-batch"}
                  className="flex items-center justify-between rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="batch"
                      checked={(b.batchId ?? undefined) === batchId}
                      onChange={() => setBatchId(b.batchId ?? undefined)}
                    />
                    {b.batchCode ?? "No batch"}
                  </span>
                  <span className="text-xs text-slate-400">{b.quantity} available</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {source && activeSku && !needsBatchChoice && batchOptions.length === 1 && (
          <p className="text-xs text-slate-400">
            Batch: {batchOptions[0].batchCode ?? "none"} ({batchOptions[0].quantity} available)
          </p>
        )}

        {readyForQuantity && (
          <>
            <input
              type="number"
              min={1}
              max={selectedBatch?.quantity}
              required
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="Quantity (partial allowed)"
              className="w-full rounded-lg border border-slate-300 px-4 py-3 text-center text-xl font-bold outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            />
            <button
              type="submit"
              disabled={submitting || source!.id === destination!.id}
              className="w-full rounded-lg bg-green-600 px-4 py-3 font-semibold text-white disabled:opacity-50"
            >
              {submitting ? "Moving…" : "Confirm transfer"}
            </button>
          </>
        )}
      </form>

      {scannerTarget && (
        <QrScannerModal
          title={scannerTarget === "item" ? "Scan item label" : `Scan ${scannerTarget} location`}
          onDecode={scannerTarget === "item" ? handleScanItem : handleScanLocation}
          onClose={() => setScannerTarget(null)}
        />
      )}
    </div>
  );
}
