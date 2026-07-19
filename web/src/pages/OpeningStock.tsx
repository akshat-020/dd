import { useState } from "react";
import { BulkOpeningStockImport } from "../components/BulkOpeningStockImport";

// Owner-only, onboarding-specific — see routes/openingStock.ts for why this
// stays separate from the normal inward-entry flow (its own StockMovement
// type, no cost attached, not part of the individual-permission catalogue).
export default function OpeningStock() {
  const [notice, setNotice] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Opening Stock</h1>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Declare a starting physical stock position — for setting the system up before or during go-live, not for logging an
        actual purchase or production event. Each row is recorded as a distinct "Opening Stock" movement, separate from the
        normal inward-entry flow, so it's never mistaken for a real receiving event in the ledger or reports.
      </p>
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        Use this only before or during initial setup. Once the warehouse is in active use, log new stock through Receiving
        (inward entry + putaway) instead — that's what keeps the normal reconciliation trail intact.
      </p>

      {notice && <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700 dark:bg-green-950 dark:text-green-300">{notice}</p>}

      <BulkOpeningStockImport onImported={() => setNotice("Opening stock imported.")} />
    </div>
  );
}
