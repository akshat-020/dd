import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Role } from "../api/types";
import type { PermissionKey } from "../lib/permissions";

export function ProtectedRoute({
  children,
  roles,
  permission,
  anyPermission,
}: {
  children: ReactNode;
  // For the handful of things that stay structurally role-based (account
  // management) or general, uncatalogued viewing access.
  roles?: Role[];
  // Passes if the user holds this permission, regardless of role — the
  // usual case for anything in the permission catalogue. Owner always
  // passes (Owner's permission list already contains every key).
  permission?: PermissionKey;
  // Passes if the user holds any one of these permissions.
  anyPermission?: PermissionKey[];
}) {
  const { user, loading, hasPermission, hasAnyPermission } = useAuth();

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  const roleOk = !roles || roles.includes(user.role);
  const permissionOk = !!permission && hasPermission(permission);
  const anyPermissionOk = !!anyPermission && hasAnyPermission(...anyPermission);
  if (!roleOk && !permissionOk && !anyPermissionOk) {
    return (
      <div className="p-6 text-center text-slate-500 dark:text-slate-400">
        You don't have permission to view this page.
      </div>
    );
  }
  return <>{children}</>;
}
