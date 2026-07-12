import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { Role } from "../api/types";

export function ProtectedRoute({
  children,
  roles,
  allowScanAccess,
  allowInwardEntryAccess,
}: {
  children: ReactNode;
  roles?: Role[];
  // When true, a Sales account with the granted scan-based putaway/pick
  // permission can also pass, even though "SALES" isn't in `roles` — this
  // is the per-person add-on, not a role.
  allowScanAccess?: boolean;
  // Same idea for the inward-entry permission.
  allowInwardEntryAccess?: boolean;
}) {
  const { user, loading, hasScanAccess, hasInwardEntryAccess } = useAuth();

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  const roleOk = !roles || roles.includes(user.role);
  const scanOk = allowScanAccess && hasScanAccess;
  const inwardOk = allowInwardEntryAccess && hasInwardEntryAccess;
  if (!roleOk && !scanOk && !inwardOk) {
    return (
      <div className="p-6 text-center text-slate-500 dark:text-slate-400">
        You don't have permission to view this page.
      </div>
    );
  }
  return <>{children}</>;
}
