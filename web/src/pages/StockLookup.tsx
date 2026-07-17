import { useEffect, useState } from "react";
import { api, ApiError } from "../api/client";
import { SkuCombobox } from "../components/SkuCombobox";
import type { Sku } from "../api/types";

interface LookupResult {
  sku: { id: string; code: string; name: string; unit: string; altUnitName?: string | null; altUnitFactor?: number | null };
  locations: { locationId: string; locationCode: string; quantity: number; compound: { boxes: number; pcs: number; label: string } | null }[];
  totalQty: number;
  compound: { boxes: number; pcs: number; label: string } | null;
}

// Standalone "where is this SKU right now" search — separate from the SKU
// master page (which Accountant can also reach) and usable whether or not
// the user has an active pick task assigned. See the route's role
// restriction in App.tsx: Owner + Sales only for now.
export default function StockLookup() {
  const [skus, setSkus] = useState<Sku[]>([]);
  const [skuId, setSkuId] = useState("");
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get<Sku[]>("/skus").then(setSkus).catch(() => {});
  }, []);

  useEffect(() => {
    if (!skuId) {
      setResult(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    api
      .get<LookupResult>(`/stock/lookup/${skuId}`)
      .then(setResult)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to look up stock for this SKU"))
      .finally(() => setLoading(false));
  }, [skuId]);

  return (
    <div className="mx-auto max-w-md space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Find Stock</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Search any SKU by code or name to see where it currently sits and how much is there — usable
        any time, whether or not you have an active pick task.
      </p>

      <SkuCombobox skus={skus} value={skuId} onChange={setSkuId} placeholder="Search SKU by code or name…" />

      {loading && <p className="text-sm text-slate-500 dark:text-slate-400">Looking up…</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {result && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-1">
            <span className="font-mono font-semibold text-slate-900 dark:text-slate-50">{result.sku.code}</span>
            <span className="text-slate-500 dark:text-slate-400"> — {result.sku.name}</span>
          </div>
          <div className="mb-3 text-sm font-medium text-slate-900 dark:text-slate-50">
            Total on hand: {result.totalQty} {result.sku.unit}
            {result.compound && <span className="ml-1 text-xs font-normal text-slate-400">= {result.compound.label}</span>}
          </div>
          {result.locations.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No stock on hand for this SKU right now.</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {result.locations.map((l) => (
                <li key={l.locationId} className="flex items-center justify-between py-2 text-sm">
                  <span className="font-mono">{l.locationCode}</span>
                  <span className="text-slate-700 dark:text-slate-300">
                    {l.quantity} {result.sku.unit}
                    {l.compound && <span className="ml-1 text-xs text-slate-400">({l.compound.label})</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
