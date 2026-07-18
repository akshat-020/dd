import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { LowStockSku, Order, Shortfall } from "../api/types";

export default function Dashboard() {
  const { user, hasRole, hasPermission } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [lowStock, setLowStock] = useState<LowStockSku[]>([]);
  const [shortfalls, setShortfalls] = useState<Shortfall[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Warehouse's visibility is task-scoped and doesn't include general order
  // browsing or stock-wide views (per the permission model), so none of
  // these calls fire for them — they get a task-focused dashboard instead
  // (below), not a 403 from calls they were never meant to make.
  const canSeeOrders = hasRole("OWNER", "ACCOUNTANT", "SALES");
  const canSeeLowStock = hasPermission("inventory.viewStockFull");
  const canSeeShortfalls = hasRole("OWNER", "SALES");

  useEffect(() => {
    if (!canSeeOrders) return;
    api.get<Order[]>("/orders").then(setOrders).catch((e) => setError(e.message));
  }, [canSeeOrders]);

  useEffect(() => {
    if (!canSeeLowStock) return;
    api.get<LowStockSku[]>("/stock/low-stock").then(setLowStock).catch(() => {});
  }, [canSeeLowStock]);

  useEffect(() => {
    if (!canSeeShortfalls) return;
    api.get<Shortfall[]>("/reports/shortfalls").then(setShortfalls).catch(() => {});
  }, [canSeeShortfalls]);

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

      {canSeeOrders ? (
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Draft orders" value={draft} to="/orders" />
          <StatCard label="Ready to pick" value={finalized} to="/picking" />
          <StatCard label="Loaded" value={loaded} to="/orders" />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Link to="/picking" className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Pick tasks</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Orders ready to pick</div>
          </Link>
          <Link to="/receiving" className="rounded-xl border border-slate-200 bg-white p-4 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-50">Putaway tasks</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Batches waiting to be shelved</div>
          </Link>
        </div>
      )}

      {canSeeShortfalls && shortfalls.length > 0 && (
        <section>
          <h2 className="mb-2 text-base font-semibold text-slate-900 dark:text-slate-50">Shortfalls needing attention</h2>
          <ul className="divide-y divide-slate-200 rounded-lg border border-amber-200 bg-amber-50 dark:divide-slate-800 dark:border-amber-900 dark:bg-amber-950">
            {shortfalls.map((s) => (
              <li key={s.pickListItemId} className="px-4 py-3 text-sm">
                <Link to={`/orders/${s.orderId}`} className="font-medium text-slate-900 underline dark:text-slate-50">
                  {s.orderNumber}
                </Link>
                <span className="text-slate-600 dark:text-slate-300">
                  {" "}
                  · {s.buyerName} · {s.skuCode} short by {s.shortfallQty}
                </span>
                <div className="text-xs text-amber-700 dark:text-amber-300">{s.note}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
