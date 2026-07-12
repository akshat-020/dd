import type { Prisma } from "@prisma/client";

export class InsufficientStockError extends Error {
  constructor(public skuId: string, public locationId: string, public available: number, public requested: number) {
    super(`Insufficient stock: requested ${requested}, only ${available} available`);
  }
}

// Applies a signed stock delta to a (sku, location, batch) cell and appends
// the corresponding ledger row, inside the given transaction. This is the
// single choke point every stock-affecting workflow (putaway, transfer,
// picking, invoice adjustment) goes through, so the ledger can never drift
// from the live StockItem quantities.
//
// Note: batchId is nullable (bulk-imported legacy stock may have no batch),
// and SQLite treats each NULL as distinct in a unique index, so we resolve
// the cell with an explicit findFirst rather than relying on Prisma's
// compound-unique upsert (which would not match existing NULL-batch rows).
export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  params: {
    skuId: string;
    locationId: string;
    batchId?: string | null;
    quantity: number; // signed delta: positive = stock added, negative = stock removed
    type: "INBOUND" | "OUTBOUND" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUSTMENT";
    reason?: string;
    refOrderId?: string;
    refInvoiceRefId?: string;
    relatedMovementId?: string;
    userId: string;
    allowNegative?: boolean;
  }
) {
  const batchId = params.batchId ?? null;

  const existing = await tx.stockItem.findFirst({
    where: { skuId: params.skuId, locationId: params.locationId, batchId },
  });

  const newQuantity = (existing?.quantity ?? 0) + params.quantity;
  if (newQuantity < 0 && !params.allowNegative) {
    throw new InsufficientStockError(params.skuId, params.locationId, existing?.quantity ?? 0, -params.quantity);
  }

  const stockItem = existing
    ? await tx.stockItem.update({ where: { id: existing.id }, data: { quantity: newQuantity } })
    : await tx.stockItem.create({ data: { skuId: params.skuId, locationId: params.locationId, batchId, quantity: newQuantity } });

  const movement = await tx.stockMovement.create({
    data: {
      skuId: params.skuId,
      locationId: params.locationId,
      batchId,
      quantity: params.quantity,
      type: params.type,
      reason: params.reason,
      refOrderId: params.refOrderId,
      refInvoiceRefId: params.refInvoiceRefId,
      relatedMovementId: params.relatedMovementId,
      userId: params.userId,
    },
  });

  return { stockItem, movement };
}
