import { Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { AuditLogEntry } from "../api/types";

interface StockOnHandRow {
  skuId: string;
  skuCode: string;
  skuName: string;
  unit: string;
  locationId: string;
  locationCode: string;
  quantity: number;
  batches: { batchId: string | null; batchCode: string | null; receivedDate: string | null; quantity: number }[];
  // Server-computed "16 Box + 3 pcs" breakdown — null for SKUs with no
  // alternate unit configured.
  compound: { boxes: number; pcs: number; label: string } | null;
}

interface TurnaroundRow {
  orderId: string;
  orderNumber: string;
  buyerName: string;
  createdAt: string;
  loadedAt: string | null;
  invoicedAt: string | null;
  minutesToLoad: number | null;
  minutesToInvoice: number | null;
}

interface SalesRow {
  skuCode: string;
  skuName: string;
  buyerName: string;
  qty: number;
  price: number;
  value: number;
  invoiceDate: string;
  tallyInvoiceNumber: string;
}

type Tab = "stock" | "turnaround" | "sales" | "audit";

export default function Reports() {
  const { hasRole } = useAuth();
  const canSeeMoney = hasRole("OWNER", "ACCOUNTANT");
  // Stock-on-hand is general inventory browsing, excluded from Warehouse's
  // task-scoped visibility (same restriction as the Stock/Locations pages).
  const canSeeStock = hasRole("OWNER", "ACCOUNTANT", "SALES");
  const [tab, setTab] = useState<Tab>(canSeeStock ? "stock" : "turnaround");

  const [stock, setStock] = useState<StockOnHandRow[]>([]);
  const [turnaround, setTurnaround] = useState<TurnaroundRow[]>([]);
  const [sales, setSales] = useState<SalesRow[]>([]);
  const [audit, setAudit] = useState<AuditLogEntry[]>([]);

  useEffect(() => {
    if (tab === "stock" && canSeeStock) api.get<StockOnHandRow[]>("/reports/stock-on-hand").then(setStock).catch(() => {});
    if (tab === "turnaround") api.get<TurnaroundRow[]>("/reports/fulfillment-turnaround").then(setTurnaround).catch(() => {});
    if (tab === "sales" && canSeeMoney) api.get<SalesRow[]>("/reports/sales").then(setSales).catch(() => {});
    if (tab === "audit" && canSeeMoney) api.get<AuditLogEntry[]>("/reports/audit-log").then(setAudit).catch(() => {});
  }, [tab, canSeeMoney, canSeeStock]);

  const tabs: { key: Tab; label: string }[] = [
    ...(canSeeStock ? [{ key: "stock" as Tab, label: "Stock on hand" }] : []),
    { key: "turnaround", label: "Turnaround" },
    ...(canSeeMoney ? [{ key: "sales" as Tab, label: "Sales" }, { key: "audit" as Tab, label: "Audit log" }] : []),
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Reports</h1>

      <div className="flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-medium ${
              tab === t.key ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900" : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "stock" && <StockOnHandTable rows={stock} />}

      {tab === "turnaround" && (
        <Table
          rows={turnaround}
          columns={[
            { key: "orderNumber", label: "Order" },
            { key: "buyerName", label: "Buyer" },
            { key: "minutesToLoad", label: "Mins → Loaded" },
            { key: "minutesToInvoice", label: "Mins → Invoiced" },
          ]}
        />
      )}

      {tab === "sales" && canSeeMoney && (
        <Table
          rows={sales}
          columns={[
            { key: "skuCode", label: "SKU" },
            { key: "buyerName", label: "Buyer" },
            { key: "qty", label: "Qty" },
            { key: "price", label: "Price" },
            { key: "value", label: "Value" },
            { key: "tallyInvoiceNumber", label: "Invoice #" },
          ]}
        />
      )}

      {tab === "audit" && canSeeMoney && (
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {audit.map((a) => (
            <li key={a.id} className="px-4 py-2 text-sm">
              <span className="font-medium text-slate-900 dark:text-slate-50">{a.action}</span>{" "}
              <span className="text-slate-500 dark:text-slate-400">
                {a.entityType} · by {a.user.name} · {new Date(a.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
          {audit.length === 0 && <li className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No audit entries yet.</li>}
        </ul>
      )}
    </div>
  );
}

// One row per (SKU, location) — the "how much of this do I have" figure —
// with per-batch detail (batch code, received date, qty) as an expandable
// drill-down underneath, rather than fragmenting the top-level list into a
// separate row per batch (see round 3 bug #3).
function StockOnHandTable({ rows }: { rows: StockOnHandRow[] }) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <tr>
            <th className="px-4 py-2 whitespace-nowrap">SKU</th>
            <th className="px-4 py-2 whitespace-nowrap">Name</th>
            <th className="px-4 py-2 whitespace-nowrap">Location</th>
            <th className="px-4 py-2 whitespace-nowrap">Qty</th>
            <th className="px-4 py-2 whitespace-nowrap">Unit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row) => {
            const key = `${row.skuId}|${row.locationId}`;
            const expanded = expandedKey === key;
            const multiBatch = row.batches.length > 1;
            return (
              <Fragment key={key}>
                <tr
                  onClick={multiBatch ? () => setExpandedKey(expanded ? null : key) : undefined}
                  className={multiBatch ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800" : undefined}
                >
                  <td className="px-4 py-2 whitespace-nowrap">{row.skuCode}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{row.skuName}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{row.locationCode}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {row.quantity}
                    {row.compound && <span className="ml-1 text-xs text-slate-400">= {row.compound.label}</span>}
                    {multiBatch && <span className="ml-1 text-xs text-slate-400">({row.batches.length} batches {expanded ? "▲" : "▼"})</span>}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">{row.unit}</td>
                </tr>
                {expanded && (
                  <tr>
                    <td colSpan={5} className="bg-slate-50 px-4 py-2 dark:bg-slate-800">
                      <ul className="space-y-1 text-xs text-slate-500 dark:text-slate-400">
                        {row.batches.map((b, idx) => (
                          <li key={b.batchId ?? idx}>
                            {b.batchCode ?? "No batch"} — {b.quantity} {row.unit}
                            {b.receivedDate ? ` (received ${new Date(b.receivedDate).toLocaleDateString()})` : ""}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No data.</p>}
    </div>
  );
}

function Table<T extends Record<string, any>>({ rows, columns }: { rows: T[]; columns: { key: keyof T; label: string }[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <tr>
            {columns.map((c) => (
              <th key={String(c.key)} className="px-4 py-2 whitespace-nowrap">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row, idx) => (
            <tr key={idx}>
              {columns.map((c) => (
                <td key={String(c.key)} className="px-4 py-2 whitespace-nowrap">
                  {row[c.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No data.</p>}
    </div>
  );
}
