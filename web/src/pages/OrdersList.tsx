import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import type { Order } from "../api/types";

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  FINALIZED: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  LOADED: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  INVOICED: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export default function OrdersList() {
  const { hasPermission } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hasExplicitFilter = !!statusFilter || !!search.trim() || !!from || !!to;

  useEffect(() => {
    // No explicit filter at all -> the server applies its own default
    // (last 3 days, plus any order still active regardless of age) instead
    // of dumping every order ever placed. Debounced so typing in the
    // search box doesn't fire a request per keystroke.
    const handle = setTimeout(() => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      api
        .get<Order[]>(qs ? `/orders?${qs}` : "/orders")
        .then(setOrders)
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(handle);
  }, [statusFilter, search, from, to]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Orders</h1>
        {hasPermission("orders.createDraft") && (
          <Link to="/orders/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900">
            + New Order
          </Link>
        )}
      </div>

      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search order code, buyer, or SKU…"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
        />
        <div className="flex flex-wrap gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            <option value="">All statuses</option>
            {["DRAFT", "FINALIZED", "LOADED", "INVOICED", "CANCELLED"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            title="From date"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
            title="To date"
          />
          {hasExplicitFilter && (
            <button
              type="button"
              onClick={() => {
                setStatusFilter("");
                setSearch("");
                setFrom("");
                setTo("");
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400"
            >
              Clear filters
            </button>
          )}
        </div>
        {!hasExplicitFilter && (
          <p className="text-xs text-slate-400">
            Showing orders from the last 3 days, plus any order still awaiting dispatch regardless of age. Search or filter above
            to reach anything older.
          </p>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {orders.map((o) => (
          <li key={o.id}>
            <Link to={`/orders/${o.id}`} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-medium text-slate-900 dark:text-slate-50">{o.orderNumber}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{o.buyerName}</div>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[o.status] ?? ""}`}>{o.status}</span>
            </Link>
          </li>
        ))}
        {orders.length === 0 && <li className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No orders yet.</li>}
      </ul>
    </div>
  );
}
