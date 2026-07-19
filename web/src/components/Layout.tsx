import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Role } from "../api/types";
import type { PermissionKey } from "../lib/permissions";

interface NavItem {
  to: string;
  label: string;
  // For the handful of things that stay structurally role-based (account
  // management) or general, uncatalogued viewing access.
  roles?: Role[];
  // Visible to anyone holding this permission, regardless of role.
  permission?: PermissionKey;
  // Visible to anyone holding any one of these permissions.
  anyPermission?: PermissionKey[];
}

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Dashboard" },
  // General order browsing/editing is excluded from Warehouse's task-scoped
  // visibility — their view is Picking + Receiving + My Tasks below.
  { to: "/orders", label: "Orders", roles: ["OWNER", "ACCOUNTANT", "SALES"] },
  { to: "/orders/new", label: "New Order", permission: "orders.createDraft" },
  { to: "/picking", label: "Picking", permission: "inventory.scanPutaway" },
  { to: "/receiving", label: "Receiving", anyPermission: ["inventory.scanPutaway", "inventory.logInwardEntry"] },
  { to: "/stock-transfer", label: "Transfer Stock", permission: "inventory.transferStock" },
  { to: "/put-backs", label: "Put-backs", permission: "inventory.scanPutaway" },
  { to: "/my-tasks", label: "My Tasks", anyPermission: ["inventory.scanPutaway", "inventory.logInwardEntry"] },
  { to: "/skus", label: "SKUs" },
  { to: "/locations", label: "Locations" },
  // Standalone SKU -> location search, independent of any active pick task.
  { to: "/stock-lookup", label: "Find Stock", permission: "inventory.viewStockFull" },
  { to: "/reports", label: "Reports" },
  { to: "/users", label: "Users", roles: ["OWNER"] },
  { to: "/settings", label: "Settings", permission: "admin.configureSettings" },
  // Onboarding-only, Owner-only — see routes/openingStock.ts.
  { to: "/opening-stock", label: "Opening Stock", roles: ["OWNER"] },
  { to: "/security", label: "Security" },
];

export default function Layout() {
  const { user, logout, hasRole, hasPermission, hasAnyPermission } = useAuth();
  const visibleItems = NAV_ITEMS.filter(
    (item) =>
      (!item.roles && !item.permission && !item.anyPermission) ||
      (!!item.roles && hasRole(...item.roles)) ||
      (!!item.permission && hasPermission(item.permission)) ||
      (!!item.anyPermission && hasAnyPermission(...item.anyPermission))
  );

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
