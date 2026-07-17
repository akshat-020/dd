import { useRef, useState } from "react";
import { api, ApiError, getToken } from "../api/client";
import type { SkuBulkCommitResponse, SkuBulkPreviewResponse, SkuBulkRowResult } from "../api/types";
import { parseCsv, rowsToObjects } from "../lib/csv";

const TEMPLATE_COLUMNS = ["code", "name", "category", "unit", "altUnitName", "altUnitFactor", "reorderThreshold"] as const;

function rowsToPayload(rawRows: Record<string, string>[], confirmed: Set<number>) {
  return rawRows.map((row, i) => {
    const payload: Record<string, string | boolean> = {};
    for (const col of TEMPLATE_COLUMNS) payload[col] = row[col] ?? "";
    if (confirmed.has(i + 1)) payload.confirmFactorChange = true;
    return payload;
  });
}

// Round: Bulk SKU Master Addition/Edit. One import path handles both add
// and update — matched by SKU code — with a preview step (no writes) before
// anything actually commits, per the requirement that a bad file shouldn't
// silently corrupt the master. Same access tier as the single-record SKU
// edit (this component is only ever rendered when that's already true).
export function BulkSkuImport({ onImported }: { onImported: () => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rawRows, setRawRows] = useState<Record<string, string>[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkuBulkPreviewResponse | null>(null);
  const [confirmedRows, setConfirmedRows] = useState<Set<number>>(new Set());
  const [commitResult, setCommitResult] = useState<SkuBulkCommitResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function downloadTemplate() {
    setError(null);
    try {
      const token = getToken();
      const res = await fetch("/api/skus/bulk/template", { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
      if (!res.ok) throw new Error("Failed to download template");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sku-bulk-import-template.csv";
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
    setConfirmedRows(new Set());
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
      await runPreview(parsed, new Set());
    } catch {
      setError("Couldn't read that file — make sure it's a CSV (Excel: File → Save As → CSV).");
    }
  }

  async function runPreview(rows: Record<string, string>[], confirmed: Set<number>) {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<SkuBulkPreviewResponse>("/skus/bulk/preview", { rows: rowsToPayload(rows, confirmed) });
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
      const res = await api.post<SkuBulkCommitResponse>("/skus/bulk/commit", { rows: rowsToPayload(rawRows, confirmedRows) });
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
    setConfirmedRows(new Set());
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function toggleConfirm(rowNumber: number) {
    setConfirmedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Bulk add / update SKUs</h2>
      <p className="text-xs text-slate-400">
        One file handles both — a row whose SKU code already exists updates it; a new code creates it. Nothing is saved until
        you review the preview below and confirm.
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
            <Stat label="New" value={preview.summary.toCreate} tone="green" />
            <Stat label="Updated" value={preview.summary.toUpdate} tone="blue" />
            <Stat label="Needs confirmation" value={preview.summary.needsConfirmation} tone="amber" />
            <Stat label="Errors" value={preview.summary.errors} tone="red" />
          </div>

          <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {preview.rows.map((r) => (
                  <PreviewRow key={r.rowNumber} row={r} confirmed={confirmedRows.has(r.rowNumber)} onToggleConfirm={() => toggleConfirm(r.rowNumber)} />
                ))}
              </tbody>
            </table>
          </div>

          <button
            onClick={handleCommit}
            disabled={busy || preview.summary.toCreate + preview.summary.toUpdate + preview.summary.needsConfirmation === 0}
            className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {busy ? "Importing…" : "Commit import"}
          </button>
        </div>
      )}

      {commitResult && (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-50">
            Created {commitResult.created}, updated {commitResult.updated}, skipped {commitResult.skipped}.
          </p>
          {commitResult.skipped > 0 && (
            <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
              {commitResult.rows
                .filter((r) => r.status === "skipped")
                .map((r) => (
                  <li key={r.rowNumber}>
                    Row {r.rowNumber} ({r.code ?? "—"}): {r.errors.length > 0 ? r.errors.join("; ") : r.confirmationMessage ?? "needs confirmation"}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "green" | "blue" | "amber" | "red" }) {
  const toneClass = {
    green: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  }[tone];
  return (
    <span className={`rounded-full px-2 py-1 font-medium ${toneClass}`}>
      {label}: {value}
    </span>
  );
}

function PreviewRow({ row, confirmed, onToggleConfirm }: { row: SkuBulkRowResult; confirmed: boolean; onToggleConfirm: () => void }) {
  const actionStyle =
    row.action === "error"
      ? "text-red-600 dark:text-red-400"
      : row.action === "create"
        ? "text-green-600 dark:text-green-400"
        : "text-blue-600 dark:text-blue-400";
  return (
    <tr>
      <td className="px-3 py-2 align-top">{row.rowNumber}</td>
      <td className="px-3 py-2 align-top font-mono">{row.code ?? "—"}</td>
      <td className={`px-3 py-2 align-top font-medium ${actionStyle}`}>{row.action}</td>
      <td className="px-3 py-2 align-top">
        {row.errors.length > 0 && <div className="text-red-600 dark:text-red-400">{row.errors.join("; ")}</div>}
        {row.changes && Object.keys(row.changes).length > 0 && (
          <ul className="text-slate-500 dark:text-slate-400">
            {Object.entries(row.changes).map(([field, { from, to }]) => (
              <li key={field}>
                {field}: {String(from ?? "—")} → {String(to ?? "—")}
              </li>
            ))}
          </ul>
        )}
        {row.requiresConfirmation && (
          <label className="mt-1 flex items-start gap-1 text-amber-700 dark:text-amber-300">
            <input type="checkbox" checked={confirmed} onChange={onToggleConfirm} className="mt-0.5" />
            <span>{row.confirmationMessage} Check to apply anyway.</span>
          </label>
        )}
      </td>
    </tr>
  );
}
