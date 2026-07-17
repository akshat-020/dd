import { useEffect, useState } from "react";
import { api } from "../api/client";

export interface PrintableLabel {
  id: string;
  qrUrl: string;
  // Identifying text shown under the QR — SKU code (or location code) as
  // the primary line, batch code / received date / anything else as
  // secondary lines.
  primary: string;
  secondary?: string[];
}

// Round 4 #6: a dedicated, isolated print surface for QR labels. Printing
// used to dump the entire page (nav, buttons, surrounding UI) because there
// was nothing telling the browser what NOT to print. This renders the
// on-screen controls (copies count + print button) and an off-screen-only
// `.print-area` (see index.css) that becomes the *only* visible thing when
// the browser actually prints, regardless of where this component sits in
// the page. Layout — one label per page (thermal/continuous-feed) vs a grid
// of labels per sheet (regular printer + adhesive label sheets) — comes
// from CompanySettings.labelPrintFormat rather than being hard-coded, since
// the printer type in use isn't decided yet.
export function LabelPrintPanel({ labels, triggerLabel = "Print" }: { labels: PrintableLabel[]; triggerLabel?: string }) {
  const [format, setFormat] = useState<"SINGLE" | "GRID">("GRID");
  const [copies, setCopies] = useState(1);

  useEffect(() => {
    api
      .get<{ labelPrintFormat: "SINGLE" | "GRID" }>("/settings/label-format")
      .then((s) => setFormat(s.labelPrintFormat))
      .catch(() => {});
  }, []);

  if (labels.length === 0) return null;

  const repeated = Array.from({ length: Math.max(1, copies) }).flatMap((_, copyIdx) =>
    labels.map((l) => ({ ...l, key: `${l.id}-${copyIdx}` }))
  );

  return (
    <>
      <div className="inline-flex items-center gap-2 print:hidden">
        <label className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          Copies
          <input
            type="number"
            min={1}
            value={copies}
            onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
            className="w-14 rounded border border-slate-300 px-1 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-800"
          />
        </label>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900"
        >
          {triggerLabel}
        </button>
      </div>

      {/* Not nested under the `print:hidden` controls above — it must be a
          sibling, otherwise a `display:none` ancestor would drop it from
          the print output entirely instead of just keeping it off-screen.
          `print:grid` vs `print:block` (never both an unconditional `grid`
          alongside `print:block`) — two same-specificity `display`
          utilities fight on source order, and `print:block` was winning
          over `grid` at actual print time, collapsing the grid layout to
          one column. */}
      <div className={`print-area hidden p-4 ${format === "GRID" ? "print:grid grid-cols-3 gap-4" : "print:block"}`}>
        {repeated.map((l, i) => (
          <div
            key={l.key}
            className={`flex flex-col items-center text-center ${format === "GRID" ? "border border-slate-300 p-2" : "p-4"}`}
            style={format === "SINGLE" && i < repeated.length - 1 ? { pageBreakAfter: "always" } : undefined}
          >
            <img src={l.qrUrl} alt={l.primary} className="h-28 w-28" />
            <div className="mt-1 font-mono text-sm font-semibold">{l.primary}</div>
            {l.secondary?.map((s, si) => (
              <div key={si} className="text-xs text-slate-600">
                {s}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
