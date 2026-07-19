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
    type: "INBOUND" | "OUTBOUND" | "TRANSFER_IN" | "TRANSFER_OUT" | "ADJUSTMENT" | "OPENING_STOCK";
    reason?: string;
    refOrderId?: string;
    refInvoiceRefId?: string;
    relatedMovementId?: string;
    userId: string;
    allowNegative?: boolean;
    // Opening Stock import only — lets a declared starting balance carry the
    // date it actually represents (e.g. "as of go-live") rather than the
    // moment it happened to be keyed in. Every other caller leaves this
    // unset and gets the real current time, same as before.
    createdAt?: Date;
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
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    },
  });

  return { stockItem, movement };
}

// How much of a SKU is already promised to *other* orders and not yet
// reflected as a physical deduction in StockItem — i.e. still-open DRAFT
// order lines (a soft promise made at order-intake time) plus FINALIZED
// orders' not-yet-picked pick list quantity (a hard allocation made at
// finalize time, but stock isn't actually decremented until the physical
// pick-confirm scan). LOADED/COMPLETED/CANCELLED orders need no entry here:
// LOADED means every pick list item already hit applyStockMovement, so it's
// already reflected in StockItem; CANCELLED/COMPLETED never held stock or
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
// allocation, and finalize() itself calls this once per line too). DRAFT
// orders never call this — they have no PickListItems yet, so editing
// qtyFinalized there is a plain field update.
//
// Scoped by orderLineId, not just (orderId, skuId) — a SKU can appear on
// more than one line of the same order, and PickListItem rows must be
// attributed to the specific line that claimed them. Getting this wrong
// silently mis-allocates: editing one line's Final Qty would read (and
// potentially release) a sibling line's pick items, or treat a sibling's
// existing allocation as if it already covered part of this line's target.
//
// - Increasing: allocates the extra quantity from on-hand stock not
//   already claimed by *this line's own* pending items, by a *sibling
//   line's* pending items (same order, same SKU, different line —
//   StockItem itself isn't decremented until the physical pick-confirm
//   scan, so a sibling line's existing unpicked allocation is still
//   physically sitting in those bins), or by *other orders*
//   (getCommittedQuantities). Throws ShortfallError if there isn't enough.
// - Decreasing: first shrinks/removes this line's own not-yet-picked
//   PickListItems, latest-sequenced first (so an in-progress early pick
//   isn't disrupted, and a sibling line's allocation is never touched). If
//   that isn't enough to absorb the whole reduction — i.e. the excess is
//   already physically picked — the remainder becomes a PutBackTask per
//   source PICKED item (most-recently-picked first) instead of erroring:
//   see the Round-4 operational-flow addendum, item 4. That stock already
//   left the shelf at pick-confirm time, so it isn't reflected as
//   available again until a warehouse account physically confirms the
//   put-back (routes/putBacks.ts) — this function only records that it's
//   owed, via the PutBackTask row (and the order line's derived
//   pendingPutBackQty), not silently drop it from the count.
export async function reconcileOrderLineAllocation(
  tx: Prisma.TransactionClient,
  params: { orderId: string; orderLineId: string; skuId: string; newQty: number }
): Promise<void> {
  const { orderId, orderLineId, skuId, newQty } = params;

  // All pick items for this SKU in this order — this line's own plus any
  // sibling lines' — needed both to scope this line's own accounting and
  // to avoid re-offering a bin a sibling line already claims.
  const allItemsForSku = await tx.pickListItem.findMany({ where: { orderId, skuId }, orderBy: { sequence: "asc" } });
  const thisLineItems = allItemsForSku.filter((i) => i.orderLineId === orderLineId);
  const siblingItems = allItemsForSku.filter((i) => i.orderLineId !== orderLineId);

  // A PICKED item's qtyPicked doesn't drop until a put-back is physically
  // *confirmed* (see the decrease branch below), so a second edit before
  // that confirmation must still know how much of that qtyPicked is
  // already earmarked for return — otherwise repeated edits would queue
  // overlapping put-back tasks that together exceed what's actually picked.
  const pendingPutBacks = await tx.putBackTask.groupBy({
    by: ["sourcePickListItemId"],
    where: { sourcePickListItemId: { in: thisLineItems.map((i) => i.id) }, status: "PENDING" },
    _sum: { quantity: true },
  });
  const pendingBySourceItem = new Map(pendingPutBacks.map((p) => [p.sourcePickListItemId, p._sum.quantity ?? 0]));

  // A PICKED item's qtyToPick is its original target, which can now exceed
  // what was actually picked (a partial pick's shortfall lives in a
  // separate follow-up row — see the picking confirm handler) — so a
  // PICKED row's contribution to the running total is what was actually
  // picked *net of any put-back already queued against it*, not the raw
  // qtyPicked and not what it was originally allocated to pick.
  const currentAllocated = thisLineItems.reduce(
    (sum, i) => sum + (i.status === "PICKED" ? i.qtyPicked - (pendingBySourceItem.get(i.id) ?? 0) : i.qtyToPick),
    0
  );

  const delta = newQty - currentAllocated;
  if (delta === 0) return;

  if (delta > 0) {
    // Reclaim from this line's own pending put-back task(s) before
    // allocating anything new — that stock never actually left the
    // loading area (a put-back is only "returned" once physically
    // confirmed), so increasing back up should cancel/shrink the pending
    // return instead of leaving it standing while also drawing fresh stock
    // from a shelf.
    let remaining = delta;
    const pendingTasksForLine = await tx.putBackTask.findMany({ where: { orderLineId, status: "PENDING" }, orderBy: { createdAt: "desc" } });
    for (const task of pendingTasksForLine) {
      if (remaining <= 0) break;
      const reclaim = Math.min(task.quantity, remaining);
      if (reclaim === task.quantity) {
        await tx.putBackTask.delete({ where: { id: task.id } });
      } else {
        await tx.putBackTask.update({ where: { id: task.id }, data: { quantity: task.quantity - reclaim } });
      }
      remaining -= reclaim;
    }
    if (remaining <= 0) return;

    const committed = await getCommittedQuantities(tx, [skuId], orderId);
    const stockItems = await tx.stockItem.findMany({ where: { skuId, quantity: { gt: 0 } }, orderBy: { quantity: "desc" } });
    const totalOnHand = stockItems.reduce((sum, s) => sum + s.quantity, 0);
    const committedElsewhere = committed.get(skuId) ?? 0;
    const siblingAllocated = siblingItems.reduce((sum, i) => sum + (i.status === "PICKED" ? 0 : i.qtyToPick), 0);
    // Re-fetch (rather than reuse the pre-reclaim map from above) since the
    // reclaim loop just mutated these rows.
    const pendingAfterReclaim = await tx.putBackTask.groupBy({
      by: ["sourcePickListItemId"],
      where: { sourcePickListItemId: { in: thisLineItems.map((i) => i.id) }, status: "PENDING" },
      _sum: { quantity: true },
    });
    const pendingBySourceItemNow = new Map(pendingAfterReclaim.map((p) => [p.sourcePickListItemId, p._sum.quantity ?? 0]));
    // This line's own already-PICKED quantity is physically off the shelf
    // (StockItem was already decremented at pick-confirm time) and so isn't
    // part of totalOnHand — it has to be credited back in here, or a line
    // that's already partially picked would look short by that same amount
    // every time it's increased further, even when there's genuinely
    // enough stock for just the increase.
    const pickedContribution = thisLineItems.reduce(
      (sum, i) => sum + (i.status === "PICKED" ? i.qtyPicked - (pendingBySourceItemNow.get(i.id) ?? 0) : 0),
      0
    );
    const trulyAvailable = totalOnHand - committedElsewhere - siblingAllocated + pickedContribution;
    if (trulyAvailable < newQty) {
      throw new ShortfallError(skuId, newQty, Math.max(trulyAvailable, 0));
    }

    // Don't re-offer bin quantity already claimed by this line's own or a
    // sibling line's not-yet-picked items.
    const reservedByCell = new Map<string, number>();
    for (const item of allItemsForSku) {
      if (item.status === "PICKED") continue;
      const key = `${item.locationId}|${item.batchId ?? ""}`;
      reservedByCell.set(key, (reservedByCell.get(key) ?? 0) + item.qtyToPick);
    }

    const maxSequence = await tx.pickListItem.aggregate({ where: { orderId }, _max: { sequence: true } });
    let sequence = maxSequence._max.sequence ?? 0;
    for (const stockItem of stockItems) {
      if (remaining <= 0) break;
      const key = `${stockItem.locationId}|${stockItem.batchId ?? ""}`;
      const reserved = reservedByCell.get(key) ?? 0;
      const free = stockItem.quantity - reserved;
      if (free <= 0) continue;
      const take = Math.min(free, remaining);
      sequence += 1;
      await tx.pickListItem.create({
        data: { orderId, orderLineId, skuId, locationId: stockItem.locationId, batchId: stockItem.batchId, sequence, qtyToPick: take },
      });
      reservedByCell.set(key, reserved + take);
      remaining -= take;
    }
  } else {
    let toRelease = -delta;
    const releasable = thisLineItems.filter((i) => i.status !== "PICKED").sort((a, b) => b.sequence - a.sequence);
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

    // Not-yet-picked allocation couldn't cover the whole reduction — the
    // remainder is already physically picked, so it needs a put-back task
    // rather than just disappearing from the count.
    if (toRelease > 0) {
      const pickedItems = thisLineItems.filter((i) => i.status === "PICKED").sort((a, b) => b.sequence - a.sequence);
      for (const item of pickedItems) {
        if (toRelease <= 0) break;
        const take = Math.min(item.qtyPicked, toRelease);
        if (take <= 0) continue;
        await tx.putBackTask.create({
          data: {
            orderId,
            orderLineId,
            skuId,
            sourcePickListItemId: item.id,
            fromLocationId: item.locationId,
            batchId: item.batchId,
            quantity: take,
          },
        });
        toRelease -= take;
      }
    }
  }
}
