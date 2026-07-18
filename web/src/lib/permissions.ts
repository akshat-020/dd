// Access Control Model — mirrors the fixed catalogue in
// server/src/lib/permissions.ts. Every permission is an individual,
// toggleable capability per person; a role is only ever the starting
// template applied once at account-creation time (see Users.tsx). Owner
// bypasses this entirely and always has every key (the server sends back
// the full list for an Owner account, so the client never special-cases it
// — it's just array membership everywhere).
export type PermissionKey =
  | "orders.createDraft"
  | "orders.viewAllDrafts"
  | "orders.editFinalized"
  | "orders.viewFullHistory"
  | "pricing.viewSalePrice"
  | "pricing.viewCostPrice"
  | "pricing.setDefaultPrice"
  | "pricing.manageInvoiceReference"
  | "pricing.managePI"
  | "pricing.logCostReference"
  | "inventory.viewStockFull"
  | "inventory.scanPutaway"
  | "inventory.logInwardEntry"
  | "inventory.transferStock"
  | "inventory.reconciliationCount"
  | "inventory.reconciliationApprove"
  | "masterdata.editSku"
  | "masterdata.bulkImportSku"
  | "masterdata.editLocation"
  | "admin.viewAuditLog"
  | "admin.configureSettings";

export interface PermissionGroup {
  label: string;
  permissions: { key: PermissionKey; label: string }[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    label: "Orders",
    permissions: [
      { key: "orders.createDraft", label: "Create a draft order" },
      { key: "orders.viewAllDrafts", label: "View all draft orders (not just your own)" },
      { key: "orders.editFinalized", label: "Edit a finalized order (add/edit lines, adjust Final Qty)" },
      { key: "orders.viewFullHistory", label: "View full order history (beyond the default 3-day/active filter)" },
    ],
  },
  {
    label: "Pricing & Financial",
    permissions: [
      { key: "pricing.viewSalePrice", label: "View sale price" },
      { key: "pricing.viewCostPrice", label: "View cost/purchase price" },
      { key: "pricing.setDefaultPrice", label: "Set/edit default price (MRP) per SKU" },
      { key: "pricing.manageInvoiceReference", label: "Create/edit the Invoice Reference" },
      { key: "pricing.managePI", label: "Create/edit a Proforma Invoice" },
      { key: "pricing.logCostReference", label: "Log a purchase cost reference" },
    ],
  },
  {
    label: "Inventory & Warehouse",
    permissions: [
      { key: "inventory.viewStockFull", label: "View stock (full, not task-scoped)" },
      { key: "inventory.scanPutaway", label: "Scan-based putaway/pick" },
      { key: "inventory.logInwardEntry", label: "Log an inward entry (quantity received, no cost)" },
      { key: "inventory.transferStock", label: "Transfer stock between locations (rack-to-rack)" },
      { key: "inventory.reconciliationCount", label: "Perform a physical reconciliation count" },
      { key: "inventory.reconciliationApprove", label: "Approve a reconciliation variance above threshold" },
    ],
  },
  {
    label: "Master Data",
    permissions: [
      { key: "masterdata.editSku", label: "Edit SKU master (name, unit, category, conversion factor)" },
      { key: "masterdata.bulkImportSku", label: "Bulk import/update SKU master" },
      { key: "masterdata.editLocation", label: "Edit/delete location master" },
    ],
  },
  {
    label: "Admin",
    permissions: [
      { key: "admin.viewAuditLog", label: "View the full audit log" },
      { key: "admin.configureSettings", label: "Configure system settings" },
    ],
  },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
