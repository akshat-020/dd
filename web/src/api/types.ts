export type Role = "OWNER" | "ACCOUNTANT" | "SALES" | "WAREHOUSE";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active?: boolean;
}

export interface Sku {
  id: string;
  code: string;
  name: string;
  unit: string;
  category?: string | null;
  reorderThreshold: number;
  active: boolean;
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
  receivedDate: string;
  note?: string | null;
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

export type OrderStatus = "DRAFT" | "FINALIZED" | "LOADED" | "INVOICED" | "CANCELLED";

export interface OrderLine {
  id: string;
  orderId: string;
  skuId: string;
  qtyRequested: number;
  qtyFinalized: number | null;
  qtyPicked: number;
  notes?: string | null;
  sku: Sku;
  unitPrice?: number | null;
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
  lines: OrderLine[];
}

export interface StockCheckResult {
  lineId: string;
  skuId: string;
  skuCode: string;
  skuName: string;
  requested: number;
  available: number;
  sufficient: boolean;
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
  sku: Sku;
  location: Location;
}

export interface InvoiceReferenceLine {
  id: string;
  skuId: string;
  qty: number;
  price: number;
  sku?: Sku;
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
