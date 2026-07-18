import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

// Task-scoped shape from GET /api/picking/orders — deliberately not the
// full Order type. That endpoint is gated on inventory.scanPutaway (rather
// than the general /api/orders role list) precisely so a Warehouse account,
// or anyone else granted scan/pick access, can reach it regardless of base
// role — see routes/picking.ts.
interface PickableOrder {
  id: string;
  orderNumber: string;
  buyerName: string;
  lineCount: number;
}

export default function Picking() {
  const [orders, setOrders] = useState<PickableOrder[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<PickableOrder[]>("/picking/orders")
      .then(setOrders)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">Ready to pick</h1>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      <ul className="space-y-2">
        {orders.map((o) => (
          <li key={o.id}>
            <Link
              to={`/picking/${o.id}`}
              className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="text-lg font-semibold text-slate-900 dark:text-slate-50">{o.orderNumber}</div>
              <div className="text-sm text-slate-500 dark:text-slate-400">{o.buyerName}</div>
              <div className="mt-1 text-xs text-slate-400">{o.lineCount} item{o.lineCount === 1 ? "" : "s"}</div>
            </Link>
          </li>
        ))}
        {orders.length === 0 && !error && <p className="text-sm text-slate-500 dark:text-slate-400">No orders waiting to be picked.</p>}
      </ul>
    </div>
  );
}
