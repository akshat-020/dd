import type { PermissionKey } from "../lib/permissions";

export type Role = "OWNER" | "ACCOUNTANT" | "SALES" | "WAREHOUSE";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active?: boolean;
  createdAt?: string;
  // Every permission this account currently holds — Owner accounts get the
  // full catalogue back (Owner bypasses the underlying grant table
  // entirely), everyone else gets exactly what's been individually granted,
  // starting from whatever their role's template applied at creation. See
  // lib/permissions.ts for the catalogue and useAuth().hasPermission.
  permissions: PermissionKey[];
  totpEnabled?: boolean;
}

export interface Session {
  id: string;
  userAgent?: string | null;
  createdAt: string;
  lastSeenAt: string;
  current?: boolean;
  user?: { id: string; name: string; email: string; role: Role };
}

export interface Sku {
  id: string;
  code: string;
  name: string;
  unit: string;
  category?: string | null;
  reorderThreshold: number;
  active: boolean;
  // Optional per-SKU compound unit (e.g. Box = 10 pcs) — both null means
  // this SKU only ever has one unit.
  altUnitName?: string | null;
  altUnitFactor?: number | null;
  // Default Price (MRP) — a prefill convenience, never a locked value (see
  // pricing.setDefaultPrice / pricing.viewSalePrice). Field-level protected
  // server-side: absent entirely from the response for a viewer without
  // one of those two permissions, not just null.
  defaultPrice?: number | null;
  defaultAltUnitPrice?: number | null;
}

export interface CompoundBreakdown {
  boxes: number;
  pcs: number;
  label: string;
}

export interface Location {
  id: string;
  code: string;
  zone: string;
  rack: string;
  bin?: string | null;
  active: boolean;
}

export interface SkuBatch {
  id: string;
  skuId: string;
  batchCode: string;
  sourceType: "PURCHASE" | "PRODUCTION";
  receivedQuantity?: number | null;
  supplierRef?: string | null;
  receivedDate: string;
  note?: string | null;
  sku?: Sku;
  // Only present on /stock/batches/recent — null means "no declared
  // quantity to compare against" (legacy batch), not "nothing left".
  remainingToShelve?: number | null;
}

export interface PurchaseCostReference {
  id: string;
  batchId: string;
  quantity: number;
  unitCost: number;
  supplierRef?: string | null;
  note?: string | null;
  createdAt: string;
}

export interface StockItem {
  id: string;
  skuId: string;
  locationId: string;
  batchId?: string | null;
  quantity: number;
  sku: Sku;
  location: Location;
  batch?: SkuBatch | null;
}

export interface StockMovement {
  id: string;
  sku: { id: string; code: string; name: string };
  location: { id: string; code: string };
  batch: { id: string; batchCode: string } | null;
  quantity: number;
  type: string;
  reason?: string | null;
  refOrderId?: string | null;
  refInvoiceRefId?: string | null;
  user: { id: string; name: string };
  createdAt: string;
}

export type OrderStatus = "DRAFT" | "FINALIZED" | "LOADED" | "COMPLETED" | "CANCELLED";

export interface OrderLine {
  id: string;
  orderId: string;
  skuId: string;
  qtyRequested: number; // always base unit — canonical
  qtyFinalized: number | null; // always base unit — canonical
  qtyPicked: number;
  notes?: string | null;
  sku: Sku;
  unitPrice?: number | null;
  // Prefill hint from the SKU's Default Price (MRP) for whichever unit this
  // line is actually in — same field-level protection as unitPrice (absent
  // entirely for a viewer without pricing access, not just null). Never
  // applied automatically; see lib/pricing.ts's skuDefaultPriceForUnit.
  defaultUnitPrice?: number | null;
  // How Requested/Final Qty were actually entered — null means this line
  // predates multi-unit support (display falls back to qty + sku.unit).
  requestedUnit?: string | null;
  requestedUnitQty?: number | null;
  requestedFactor?: number | null;
  finalUnit?: string | null;
  finalUnitQty?: number | null;
  finalFactor?: number | null;
  // Picked-but-not-yet-physically-returned quantity — see PutBackTask.
  // Zero means nothing pending for this line.
  pendingPutBackQty?: number;
}

export interface Order {
  id: string;
  orderNumber: string;
  buyerName: string;
  buyerContact?: string | null;
  status: OrderStatus;
  vehicleCapacityNote?: string | null;
  createdBy: { id: string; name: string };
  createdAt: string;
  finalizedAt?: string | null;
  loadedAt?: string | null;
  // Set by the explicit "Mark Dispatched" action (LOADED -> COMPLETED) —
  // independent of Invoice Reference creation, which can happen before,
  // during, or after dispatch.
  completedAt?: string | null;
  lines: OrderLine[];
}

export interface StockCheckResult {
  lineId: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  requested: number;
  available: number;
  committedElsewhere: number;
  sufficient: boolean;
}

export interface StockSummaryEntry {
  skuId: string;
  totalQty: number;
  committedQty: number;
  availableQty: number;
}

export interface PickListItem {
  id: string;
  orderId: string;
  skuId: string;
  locationId: string;
  batchId?: string | null;
  sequence: number;
  qtyToPick: number;
  qtyPicked: number;
  status: "PENDING" | "LOCATION_CONFIRMED" | "SKU_CONFIRMED" | "PICKED";
  pickedBy?: { id: string; name: string } | null;
  pickedAt?: string | null;
  isShortfallFollowup?: boolean;
  note?: string | null;
  sku: Sku;
  location: Location;
  // How the picker actually expressed the picked quantity, and whether a
  // box was deliberately opened to fulfill a partial-box quantity.
  pickedUnit?: string | null;
  pickedUnitQty?: number | null;
  boxesOpened?: number;
}

export interface InvoiceReferenceLine {
  id: string;
  skuId: string;
  qty: number; // in `unit` if set, else the SKU's base unit — what was billed
  price: number; // per 1 of `unit`
  sku?: Sku;
  unit?: string | null;
  unitFactor?: number | null;
  qtyBaseUnits?: number | null;
}

export interface InvoiceReference {
  id: string;
  tallyInvoiceNumber: string;
  orderId: string;
  date: string;
  status: "ACTIVE" | "CANCELLED" | "ADJUSTED";
  createdBy: { id: string; name: string };
  createdAt: string;
  lines: InvoiceReferenceLine[];
}

export interface LowStockSku {
  id: string;
  code: string;
  name: string;
  reorderThreshold: number;
  totalQty: number;
}

export interface Shortfall {
  pickListItemId: string;
  orderId: string;
  orderNumber: string;
  buyerName: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  locationCode: string;
  shortfallQty: number;
  note?: string | null;
}

export interface MyTaskHistory {
  picks: {
    id: string;
    skuCode: string;
    skuName: string;
    locationCode: string;
    qty: number;
    orderNumber: string;
    pickedAt: string | null;
  }[];
  putaways: {
    id: string;
    skuCode: string;
    skuName: string;
    locationCode: string;
    batchCode: string | null;
    qty: number;
    createdAt: string;
  }[];
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: string | null;
  after?: string | null;
  createdAt: string;
  user: { id: string; name: string; role: Role };
}

// Per-order Activity/History entry (GET /orders/:id/audit) — `summary` is
// always role-safe; `before`/`after` are only present for Owner/Accountant.
export interface OrderAuditEntry {
  id: string;
  action: string;
  entityType: string;
  createdAt: string;
  user: { id: string; name: string; role: Role };
  summary: string;
  before?: unknown;
  after?: unknown;
}

export interface PutBackTask {
  id: string;
  orderId: string;
  orderLineId: string;
  skuId: string;
  sourcePickListItemId: string;
  fromLocationId: string;
  batchId?: string | null;
  quantity: number;
  status: "PENDING" | "CONFIRMED";
  toLocationId?: string | null;
  confirmedAt?: string | null;
  createdAt: string;
  sku: Sku;
  fromLocation: Location;
  order: { id: string; orderNumber: string; buyerName: string };
}

export interface CompanySettings {
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
  labelPrintFormat: "SINGLE" | "GRID";
}

export interface ProformaInvoiceLine {
  id: string;
  skuId: string;
  qty: number;
  unit: string;
  unitPrice: number;
  sku?: Sku;
}

export interface ProformaInvoice {
  id: string;
  piNumber: string;
  orderId: string;
  version: number;
  status: "ACTIVE" | "SUPERSEDED";
  issueDate: string;
  validUntil: string;
  createdBy: { id: string; name: string };
  createdAt: string;
  lines: ProformaInvoiceLine[];
}

// Bulk SKU import (add + update in one pass, matched by SKU code) — see
// POST /skus/bulk/preview and /commit.
export interface SkuBulkRowResult {
  rowNumber: number;
  code: string | null;
  action: "create" | "update" | "error";
  errors: string[];
  // Present only for "update" — fields that would actually change, keyed
  // by field name. Blank cells left out of the file entirely aren't here
  // (they mean "leave unchanged", not "clear this field").
  changes?: Record<string, { from: unknown; to: unknown }>;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

export interface SkuBulkPreviewResponse {
  rows: SkuBulkRowResult[];
  summary: { toCreate: number; toUpdate: number; needsConfirmation: number; errors: number };
}

export interface SkuBulkCommitRowResult extends SkuBulkRowResult {
  status: "created" | "updated" | "unchanged" | "skipped";
}

export interface SkuBulkCommitResponse {
  created: number;
  updated: number;
  skipped: number;
  rows: SkuBulkCommitRowResult[];
}

// Opening Stock import (onboarding-only, Owner-only) — see
// POST /opening-stock/preview and /commit.
export interface OpeningStockRowResult {
  rowNumber: number;
  skuCode: string | null;
  locationCode: string | null;
  quantity: number | null;
  action: "apply" | "error";
  errors: string[];
}

export interface OpeningStockPreviewResponse {
  rows: OpeningStockRowResult[];
  summary: { toApply: number; errors: number };
}

export interface OpeningStockCommitResponse {
  applied: number;
  skipped: number;
  rows: OpeningStockRowResult[];
}
