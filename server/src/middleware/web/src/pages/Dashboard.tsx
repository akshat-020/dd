import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { LowStockSku, Order } from "../api/types";

export default function Dashboard() {
  const { user, hasRole } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [lowStock, setLowStock] = useState<LowStockSku[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Warehouse's visibility is task-scoped and doesn't include general stock
  // browsing (low-stock is an inventory-wide view), so that call is skipped
  // entirely for them rather than firing and getting a 403.
  const canSeeLowStock = hasRole("OWNER", "ACCOUNTANT", "SALES");

  useEffect(() => {
    api.get<Order[]>("/orders").then(setOrders).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!canSeeLowStock) return;
    api.get<LowStockSku[]>("/stock/low-stock").then(setLowStock).catch(() => {});
  }, [canSeeLowStock]);

  const draft = orders.filter((o) => o.status === "DRAFT").length;
  const finalized = orders.filter((o) => o.status === "FINALIZED").length;
  const loaded = orders.filter((o) => o.status === "LOADED").length;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Welcome, {user?.name}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{user?.role} view</p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Draft orders" value={draft} to="/orders" />
        <StatCard label="Ready to pick" value={finalized} to="/picking" />
        <StatCard label="Loaded" value={loaded} to="/orders" />
      </div>

      {canSeeLowStock && (
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900 dark:text-slate-50">Low stock</h2>
          {lowStock.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">Nothing below reorder threshold.</p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
              {lowStock.map((s) => (
                <li key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="font-medium text-slate-900 dark:text-slate-50">
                    {s.code} · {s.name}
                  </span>
                  <span className="text-red-600 dark:text-red-400">
                    {s.totalQty} / {s.reorderThreshold}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function StatCard({ label, value, to }: { label: string; value: number; to: string }) {
  return (
    <Link to={to} className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-2xl font-semibold text-slate-900 dark:text-slate-50">{value}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
    </Link>
  );
}
