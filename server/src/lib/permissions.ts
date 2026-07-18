import { prisma } from "./prisma.js";
import type { Role } from "./roles.js";

// Access Control Model: every permission is an individual, toggleable
// capability per person — a role is only ever a starting template applied
// once at account-creation time (see ROLE_TEMPLATES below), never the
// permanent source of truth. Owner is the one exception: Owner always has
// every permission, unconditionally, and never gets rows in UserPermission
// (see hasPermission) — consistent with Owner being the only unrestricted
// role everywhere else in the system.
//
// This catalogue is the complete, fixed list of grantable keys. A key that
// doesn't appear here can't be granted — and per the deny-by-default rule,
// a key added here later starts unassigned for every existing non-Owner
// account until an Owner explicitly grants it.
const PERMISSIONS = {
  "orders.createDraft": "Create a draft order",
  "orders.viewAllDrafts": "View all draft orders (not just your own)",
  "orders.editFinalized": "Edit a finalized order (add/edit lines, adjust Final Qty)",
  "orders.viewFullHistory": "View full order history (beyond the default 3-day/active filter)",

  "pricing.viewSalePrice": "View sale price",
  "pricing.viewCostPrice": "View cost/purchase price",
  "pricing.setDefaultPrice": "Set/edit default price (MRP) per SKU",
  "pricing.manageInvoiceReference": "Create/edit the Invoice Reference",
  "pricing.managePI": "Create/edit a Proforma Invoice",
  "pricing.logCostReference": "Log a purchase cost reference",

  "inventory.viewStockFull": "View stock (full, not task-scoped)",
  "inventory.scanPutaway": "Scan-based putaway/pick",
  "inventory.logInwardEntry": "Log an inward entry (quantity received, no cost)",
  "inventory.transferStock": "Transfer stock between locations (rack-to-rack)",
  "inventory.reconciliationCount": "Perform a physical reconciliation count",
  "inventory.reconciliationApprove": "Approve a reconciliation variance above threshold",

  "masterdata.editSku": "Edit SKU master (name, unit, category, conversion factor)",
  "masterdata.bulkImportSku": "Bulk import/update SKU master",
  "masterdata.editLocation": "Edit/delete location master",

  "admin.viewAuditLog": "View the full audit log",
  "admin.configureSettings": "Configure system settings",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export function permissionLabel(key: PermissionKey): string {
  return PERMISSIONS[key];
}

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: string): value is PermissionKey {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

// Grouping for display only (e.g. the User Management permission matrix) —
// doesn't affect what's grantable, just how it's organized on screen.
export const PERMISSION_GROUPS: { label: string; keys: PermissionKey[] }[] = [
  { label: "Orders", keys: ["orders.createDraft", "orders.viewAllDrafts", "orders.editFinalized", "orders.viewFullHistory"] },
  {
    label: "Pricing & Financial",
    keys: [
      "pricing.viewSalePrice",
      "pricing.viewCostPrice",
      "pricing.setDefaultPrice",
      "pricing.manageInvoiceReference",
      "pricing.managePI",
      "pricing.logCostReference",
    ],
  },
  {
    label: "Inventory & Warehouse",
    keys: [
      "inventory.viewStockFull",
      "inventory.scanPutaway",
      "inventory.logInwardEntry",
      "inventory.transferStock",
      "inventory.reconciliationCount",
      "inventory.reconciliationApprove",
    ],
  },
  { label: "Master Data", keys: ["masterdata.editSku", "masterdata.bulkImportSku", "masterdata.editLocation"] },
  { label: "Admin", keys: ["admin.viewAuditLog", "admin.configureSettings"] },
];

// Role-template defaults — derived directly from this app's pre-existing
// role-based access (the exact same role lists every route used to gate on
// before this model existed), so introducing individual per-person toggles
// doesn't change anyone's effective access on day one. Applied once, at
// account-creation time only (see routes/users.ts) — never re-applied or
// reconciled against a role change afterward, since permissions are
// individually owned from that point on.
export const ROLE_TEMPLATES: Record<Role, PermissionKey[]> = {
  OWNER: [], // bypasses the table entirely — see hasPermission
  ACCOUNTANT: [
    "pricing.viewSalePrice",
    "pricing.viewCostPrice",
    "pricing.setDefaultPrice",
    "pricing.manageInvoiceReference",
    "pricing.managePI",
    "pricing.logCostReference",
    "inventory.viewStockFull",
    "masterdata.editSku",
    "masterdata.bulkImportSku",
    "masterdata.editLocation",
    "admin.viewAuditLog",
    "orders.viewFullHistory",
  ],
  SALES: ["orders.createDraft", "orders.editFinalized", "inventory.viewStockFull", "inventory.logInwardEntry"],
  WAREHOUSE: ["inventory.scanPutaway", "inventory.transferStock", "masterdata.editSku", "masterdata.bulkImportSku", "masterdata.editLocation"],
};

export async function hasPermission(user: { id: string; role: Role }, permission: PermissionKey): Promise<boolean> {
  if (user.role === "OWNER") return true;
  const row = await prisma.userPermission.findUnique({ where: { userId_permission: { userId: user.id, permission } } });
  return !!row;
}

export async function hasAnyPermission(user: { id: string; role: Role }, permissions: PermissionKey[]): Promise<boolean> {
  if (user.role === "OWNER") return true;
  const count = await prisma.userPermission.count({ where: { userId: user.id, permission: { in: permissions } } });
  return count > 0;
}

// Applies a role's default permission set to a newly-created account —
// called once, at creation time (routes/users.ts). Owner accounts get no
// rows (they bypass the table). `grantedById` is the account that created
// the user (an Owner, since account creation is Owner-only), so the
// append-only grant history reads naturally even for template defaults.
export async function applyRoleTemplate(userId: string, role: Role, grantedById: string) {
  const defaults = ROLE_TEMPLATES[role] ?? [];
  if (defaults.length === 0) return;
  await prisma.userPermission.createMany({
    data: defaults.map((permission) => ({ userId, permission, grantedById })),
    skipDuplicates: true,
  });
}
