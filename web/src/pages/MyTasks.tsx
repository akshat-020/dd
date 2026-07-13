import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { MyTaskHistory } from "../api/types";

// Own recently completed work — picks and putaways — so a warehouse
// account can answer "did I pick that?" without needing general order or
// stock-browsing access (per the permission model's task-scoped
// visibility). Not a general history/audit view; scoped to this user only.
export default function MyTasks() {
  const [history, setHistory] = useState<MyTaskHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<MyTaskHistory>("/reports/my-task-history").then(setHistory).catch((e) => setError(e.message));
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-50">My recent tasks</h1>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      <section>
        <h2 className="mb-2 text-base font-semibold text-slate-900 dark:text-slate-50">Recent picks</h2>
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {history?.picks.map((p) => (
            <li key={p.id} className="px-4 py-2 text-sm">
              <div className="text-slate-900 dark:text-slate-50">
                {p.skuCode} × {p.qty} <span className="text-slate-400">from {p.locationCode}</span>
              </div>
              <div className="text-xs text-slate-400">
                {p.orderNumber} · {p.pickedAt ? new Date(p.pickedAt).toLocaleString() : "—"}
              </div>
            </li>
          ))}
          {history && history.picks.length === 0 && <li className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No picks yet.</li>}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-base font-semibold text-slate-900 dark:text-slate-50">Recent putaways</h2>
        <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {history?.putaways.map((p) => (
            <li key={p.id} className="px-4 py-2 text-sm">
              <div className="text-slate-900 dark:text-slate-50">
                {p.skuCode} × {p.qty} <span className="text-slate-400">to {p.locationCode}</span>
              </div>
              <div className="text-xs text-slate-400">
                {p.batchCode ? `${p.batchCode} · ` : ""}
                {new Date(p.createdAt).toLocaleString()}
              </div>
            </li>
          ))}
          {history && history.putaways.length === 0 && <li className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">No putaways yet.</li>}
        </ul>
      </section>
    </div>
  );
}
