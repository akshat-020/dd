import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Role } from "../api/types";

interface NavItem {
  to: string;
  label: string;
  roles?: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard" },
  { to: "/orders", label: "Orders" },
  { to: "/orders/new", label: "New Order", roles: ["OWNER", "SALES"] },
  { to: "/picking", label: "Picking", roles: ["OWNER", "WAREHOUSE"] },
  { to: "/receiving", label: "Receiving", roles: ["OWNER", "ACCOUNTANT", "WAREHOUSE"] },
  { to: "/skus", label: "SKUs" },
  { to: "/locations", label: "Locations" },
  { to: "/pricing", label: "Pricing", roles: ["OWNER", "ACCOUNTANT"] },
  { to: "/reports", label: "Reports" },
  { to: "/users", label: "Users", roles: ["OWNER"] },
];

export default function Layout() {
  const { user, logout, hasRole } = useAuth();
  const visibleItems = NAV_ITEMS.filter((item) => !item.roles || hasRole(...item.roles));

  return (
    <div className="flex min-h-full flex-col bg-slate-50 dark:bg-slate-950">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-50">OMS / ERP</div>
          {user && (
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {user.name} · {user.role}
            </div>
          )}
        </div>
        <button
          onClick={logout}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 dark:border-slate-700 dark:text-slate-300"
        >
          Sign out
        </button>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-2 py-2 dark:border-slate-800 dark:bg-slate-900">
        {visibleItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `shrink-0 rounded-full px-3 py-2 text-sm font-medium whitespace-nowrap ${
                isActive
                  ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="flex-1 px-4 py-4">
        <Outlet />
      </main>
    </div>
  );
}
