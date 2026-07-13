import type { Prisma } from "@prisma/client";
import type { prisma as prismaClient } from "./prisma.js";

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

// How much of a SKU is already promised to *other* orders and not yet
// reflected as a physical deduction in StockItem — i.e. still-open DRAFT
// order lines (a soft promise made at order-intake time) plus FINALIZED
// orders' not-yet-picked pick list quantity (a hard allocation made at
// finalize time, but stock isn't actually decremented until the physical
// pick-confirm scan). LOADED/INVOICED/CANCELLED orders need no entry here:
// LOADED means every pick list item already hit applyStockMovement, so it's
// already reflected in StockItem; CANCELLED/INVOICED never held stock or
// already released it. Pass `excludeOrderId` to leave the order being
// evaluated out of its own commitment total.
export async function getCommittedQuantities(
  db: Pick<typeof prismaClient, "orderLine" | "pickListItem">,
  skuIds: string[],
  excludeOrderId?: string
): Promise<Map<string, number>> {
  const committed = new Map<string, number>();
  if (skuIds.length === 0) return committed;

  const draftLines = await db.orderLine.findMany({
    where: {
      skuId: { in: skuIds },
      order: { status: "DRAFT", ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}) },
    },
    select: { skuId: true, qtyRequested: true, qtyFinalized: true },
  });
  for (const line of draftLines) {
    const qty = line.qtyFinalized ?? line.qtyRequested;
    committed.set(line.skuId, (committed.get(line.skuId) ?? 0) + qty);
  }

  const pendingPickItems = await db.pickListItem.findMany({
    where: {
      skuId: { in: skuIds },
      status: { not: "PICKED" },
      order: { status: "FINALIZED", ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}) },
    },
    select: { skuId: true, qtyToPick: true, qtyPicked: true },
  });
  for (const item of pendingPickItems) {
    const remaining = Math.max(item.qtyToPick - item.qtyPicked, 0);
    committed.set(item.skuId, (committed.get(item.skuId) ?? 0) + remaining);
  }

  return committed;
}

// The inward -> putaway task lifecycle: logging a batch (POST
// /stock/batches) declares `receivedQuantity` — the total that should end
// up shelved. Each putaway (POST /stock/putaway with a batchId) records an
// INBOUND StockMovement tagged with that batchId and reason "Putaway".
// "Remaining to shelve" for a batch is `receivedQuantity - sum(those
// movements' quantity)`. The putaway task for a batch closes — stops being
// offered in "Pick a batch to shelve" — the moment remaining reaches 0.
// Legacy/bulk-imported batches with no declared receivedQuantity have no
// way to compute a target, so they're never considered closed by this
// logic (always offered) since there's nothing to compare against.
export async function getShelvedQuantities(
  db: Pick<typeof prismaClient, "stockMovement">,
  batchIds: string[]
): Promise<Map<string, number>> {
  const shelved = new Map<string, number>();
  if (batchIds.length === 0) return shelved;
  const grouped = await db.stockMovement.groupBy({
    by: ["batchId"],
    where: { batchId: { in: batchIds }, type: "INBOUND", reason: "Putaway" },
    _sum: { quantity: true },
  });
  for (const g of grouped) {
    if (g.batchId) shelved.set(g.batchId, g._sum.quantity ?? 0);
  }
  return shelved;
}

export class ShortfallError extends Error {
  constructor(public skuId: string, public requested: number, public available: number) {
    super(`Insufficient stock to reach the new quantity: requested ${requested}, only ${available} truly available`);
  }
}

// Reconciles a FINALIZED order line's pick-list allocation after its Final
// Qty changes (or when a brand-new line is added to an already-finalized
// order — that's just this same logic starting from zero existing
// allocation). DRAFT orders never call this — they have no PickListItems
// yet, so editing qtyFinalized there is a plain field update.
//
// - Increasing: allocates the extra quantity from on-hand stock not
//   already claimed by *this* order's own pending items (StockItem itself
//   isn't decremented until the physical pick-confirm scan, so this
//   order's existing unpicked allocation is still physically sitting in
//   those bins and would otherwise be double-counted) or by *other*
//   orders (getCommittedQuantities). Throws ShortfallError if there isn't
//   enough.
// - Decreasing: shrinks/removes this order's own not-yet-picked
//   PickListItems, latest-sequenced first (so an in-progress early pick
//   isn't disrupted). Throws if the reduction would cut below what's
//   already been physically picked — that's a real stock-reversal
//   decision, not something an edit should do silently.
export async function reconcileOrderLineAllocation(
  tx: Prisma.TransactionClient,
  params: { orderId: string; skuId: string; newQty: number }
): Promise<void> {
  const { orderId, skuId, newQty } = params;

  const existingItems = await tx.pickListItem.findMany({ where: { orderId, skuId }, orderBy: { sequence: "asc" } });
  // A PICKED item's qtyToPick is its original target, which can now exceed
  // what was actually picked (a partial pick's shortfall lives in a
  // separate follow-up row — see the picking confirm handler) — so a
  // PICKED row's contribution to the running total is what was actually
  // picked, not what it was originally allocated to pick.
  const currentAllocated = existingItems.reduce((sum, i) => sum + (i.status === "PICKED" ? i.qtyPicked : i.qtyToPick), 0);
  const currentPicked = existingItems.reduce((sum, i) => sum + i.qtyPicked, 0);

  if (newQty < currentPicked) {
    throw new Error(`Cannot reduce quantity below the ${currentPicked} already picked for this item`);
  }

  const delta = newQty - currentAllocated;
  if (delta === 0) return;

  if (delta > 0) {
    const committed = await getCommittedQuantities(tx, [skuId], orderId);
    const stockItems = await tx.stockItem.findMany({ where: { skuId, quantity: { gt: 0 } }, orderBy: { quantity: "desc" } });
    const totalOnHand = stockItems.reduce((sum, s) => sum + s.quantity, 0);
    const committedElsewhere = committed.get(skuId) ?? 0;
    const trulyAvailable = totalOnHand - committedElsewhere;
    if (trulyAvailable < newQty) {
      throw new ShortfallError(skuId, newQty, Math.max(trulyAvailable, 0));
    }

    // Don't re-offer bin quantity this order has already claimed via its
    // own existing (not-yet-picked) items.
    const reservedByCell = new Map<string, number>();
    for (const item of existingItems) {
      if (item.status === "PICKED") continue;
      const key = `${item.locationId}|${item.batchId ?? ""}`;
      reservedByCell.set(key, (reservedByCell.get(key) ?? 0) + item.qtyToPick);
    }

    const maxSequence = await tx.pickListItem.aggregate({ where: { orderId }, _max: { sequence: true } });
    let sequence = maxSequence._max.sequence ?? 0;
    let remaining = delta;
    for (const stockItem of stockItems) {
      if (remaining <= 0) break;
      const key = `${stockItem.locationId}|${stockItem.batchId ?? ""}`;
      const reserved = reservedByCell.get(key) ?? 0;
      const free = stockItem.quantity - reserved;
      if (free <= 0) continue;
      const take = Math.min(free, remaining);
      sequence += 1;
      await tx.pickListItem.create({
        data: { orderId, skuId, locationId: stockItem.locationId, batchId: stockItem.batchId, sequence, qtyToPick: take },
      });
      reservedByCell.set(key, reserved + take);
      remaining -= take;
    }
  } else {
    let toRelease = -delta;
    const releasable = existingItems.filter((i) => i.status !== "PICKED").sort((a, b) => b.sequence - a.sequence);
    for (const item of releasable) {
      if (toRelease <= 0) break;
      if (item.qtyToPick <= toRelease) {
        await tx.pickListItem.delete({ where: { id: item.id } });
        toRelease -= item.qtyToPick;
      } else {
        await tx.pickListItem.update({ where: { id: item.id }, data: { qtyToPick: item.qtyToPick - toRelease } });
        toRelease = 0;
      }
    }
  }
}
