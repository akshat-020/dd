import { useRef, useState } from "react";
import { api, ApiError, getToken } from "../api/client";
import type { OpeningStockCommitResponse, OpeningStockPreviewResponse, OpeningStockRowResult } from "../api/types";
import { parseCsv, rowsToObjects } from "../lib/csv";

const TEMPLATE_COLUMNS = ["skuCode", "locationCode", "quantity", "batchCode", "date"] as const;

function rowsToPayload(rawRows: Record<string, string>[]) {
  return rawRows.map((row) => {
    const payload: Record<string, string> = {};
    for (const col of TEMPLATE_COLUMNS) payload[col] = row[col] ?? "";
    return payload;
  });
}

// Onboarding-only: declares a starting physical stock position (SKU +
// Location + quantity, base unit) as a one-time go-live baseline — see
// routes/openingStock.ts for why this is its own movement type and
// Owner-only. Preview-then-commit, same two-step pattern as BulkSkuImport,
// so a bad file can't silently write anything before it's been reviewed.
export function BulkOpeningStockImport({ onImported }: { onImported: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rawRows, setRawRows] = useState<Record<string, string>[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpeningStockPreviewResponse | null>(null);
  const [commitResult, setCommitResult] = useState<OpeningStockCommitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function downloadTemplate() {
    setError(null);
    try {
      const token = getToken();
      const res = await fetch("/api/opening-stock/template", { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error("Failed to download template");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "opening-stock-template.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Failed to download template");
    }
  }

  async function handleFile(file: File) {
    setError(null);
    setCommitResult(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      const parsed = rowsToObjects(parseCsv(text));
      if (parsed.length === 0) {
        setError("That file has no data rows.");
        setRawRows(null);
        setPreview(null);
        return;
      }
      setRawRows(parsed);
      await runPreview(parsed);
    } catch {
      setError("Couldn't read that file — make sure it's a CSV (Excel: File → Save As → CSV).");
    }
  }

  async function runPreview(rows: Record<string, string>[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<OpeningStockPreviewResponse>("/opening-stock/preview", { rows: rowsToPayload(rows) });
      setPreview(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to preview import");
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!rawRows) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<OpeningStockCommitResponse>("/opening-stock/commit", { rows: rowsToPayload(rawRows) });
      setCommitResult(res);
      setPreview(null);
      onImported();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to commit import");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setRawRows(null);
    setFileName(null);
    setPreview(null);
    setCommitResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Import opening stock</h2>
      <p className="text-xs text-slate-400">
        Quantity is always in the SKU's base unit (Pcs). Batch code and date are optional. Nothing is saved until you review
        the preview below and commit.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={downloadTemplate}
          className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
        >
          Download CSV template
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} className="text-xs" />
        {(rawRows || commitResult) && (
          <button type="button" onClick={reset} className="text-xs font-medium text-slate-500 underline dark:text-slate-400">
            Start over
          </button>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {fileName && preview && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">{fileName}</p>
          <div className="flex flex-wrap gap-2 text-xs">
            <Stat label="To apply" value={preview.summary.toApply} tone="green" />
            <Stat label="Errors" value={preview.summary.errors} tone="red" />
          </div>

          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {preview.rows.map((r) => (
                  <PreviewRow key={r.rowNumber} row={r} />
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={handleCommit}
            disabled={busy || preview.summary.toApply === 0}
            className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {busy ? "Importing…" : `Apply opening stock (${preview.summary.toApply})`}
          </button>
        </div>
      )}

      {commitResult && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-50">
            Applied {commitResult.applied}, skipped {commitResult.skipped}.
          </p>
          {commitResult.skipped > 0 && (
            <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
              {commitResult.rows
                .filter((r) => r.action === "error")
                .map((r) => (
                  <li key={r.rowNumber}>
                    Row {r.rowNumber} ({r.skuCode ?? "—"}): {r.errors.join("; ")}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "green" | "red" }) {
  const toneClass = {
    green: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  }[tone];
  return (
    <span className={`rounded-full px-2 py-1 font-medium ${toneClass}`}>
      {label}: {value}
    </span>
  );
}

function PreviewRow({ row }: { row: OpeningStockRowResult }) {
  const actionStyle = row.action === "error" ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400";
  return (
    <tr>
      <td className="px-3 py-2 align-top">{row.rowNumber}</td>
      <td className="px-3 py-2 align-top font-mono">{row.skuCode ?? "—"}</td>
      <td className="px-3 py-2 align-top font-mono">{row.locationCode ?? "—"}</td>
      <td className="px-3 py-2 align-top">{row.quantity ?? "—"}</td>
      <td className={`px-3 py-2 align-top font-medium ${actionStyle}`}>{row.action === "error" ? row.errors.join("; ") : "OK"}</td>
    </tr>
  );
}
