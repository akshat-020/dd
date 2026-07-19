import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { applyStockMovement, InsufficientStockError } from "../lib/stock.js";

export const pickingRouter = Router();

pickingRouter.use(requireAuth);

// Task-scoped entry point for the "Ready to pick" screen: every FINALIZED
// order, regardless of who created it. Deliberately separate from GET
// /api/orders (general order browsing, gated to the OWNER/ACCOUNTANT/SALES
// role list — see that route's comment) so that anyone holding
// inventory.scanPutaway can reach it regardless of their base role. That's
// the exact case the access-control model exists to support — a Warehouse
// account, or a Sales account additionally granted scan/pick access — and
// was previously broken: this screen fetched through the general orders
// endpoint, which hard-excludes anyone outside that role list even with
// the permission granted. Never includes price, same as the rest of this
// file.
pickingRouter.get("/orders", requirePermission("inventory.scanPutaway"), async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: "FINALIZED" },
    include: { lines: { select: { id: true } } },
    orderBy: { finalizedAt: "asc" },
  });
  res.json(
    orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      buyerName: o.buyerName,
      lineCount: o.lines.length,
    }))
  );
});

// Loading/warehouse-facing pick list: SKU, quantity, location only — never
// price. Deliberately does not include OrderLinePrice anywhere in this file.
pickingRouter.get("/orders/:orderId", async (req, res) => {
  const items = await prisma.pickListItem.findMany({
    where: { orderId: req.params.orderId },
    include: { sku: true, location: true, pickedBy: { select: { id: true, name: true } } },
    orderBy: { sequence: "asc" },
  });
  res.json(items);
});

pickingRouter.get("/items/:itemId", async (req, res) => {
  const item = await prisma.pickListItem.findUnique({
    where: { id: req.params.itemId },
    include: { sku: true, location: true },
  });
  if (!item) return res.status(404).json({ error: "Pick list item not found" });
  res.json(item);
});

const scanLocationSchema = z.object({ locationCode: z.string().min(1) });

pickingRouter.post("/items/:itemId/scan-location", requirePermission("inventory.scanPutaway"), async (req, res) => {
  const parsed = scanLocationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const item = await prisma.pickListItem.findUnique({ where: { id: req.params.itemId }, include: { location: true } });
  if (!item) return res.status(404).json({ error: "Pick list item not found" });
  if (item.status === "PICKED") return res.status(409).json({ error: "Item already picked" });

  if (item.location.code !== parsed.data.locationCode) {
    return res.status(409).json({ error: "Scanned location does not match the pick list", expected: item.location.code });
  }
  const updated = await prisma.pickListItem.update({ where: { id: item.id }, data: { status: "LOCATION_CONFIRMED" } });
  res.json(updated);
});

const scanSkuSchema = z.object({ label: z.string().min(1) });

pickingRouter.post("/items/:itemId/scan-sku", requirePermission("inventory.scanPutaway"), async (req, res) => {
  const parsed = scanSkuSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const item = await prisma.pickListItem.findUnique({ where: { id: req.params.itemId }, include: { sku: true } });
  if (!item) return res.status(404).json({ error: "Pick list item not found" });
  if (item.status === "PICKED") return res.status(409).json({ error: "Item already picked" });
  if (item.status === "PENDING") {
    return res.status(409).json({ error: "Scan the location QR before scanning the SKU label" });
  }

  // Accept either the full encoded label ("SKU:code|BATCH:x|DATE:y") from a
  // camera scan, or a bare SKU code from the manual-entry fallback — mirrors
  // the same fallback the client uses before it ever calls this endpoint.
  const skuMatch = /SKU:([^|]+)/.exec(parsed.data.label);
  const scannedCode = skuMatch ? skuMatch[1] : parsed.data.label;
  if (scannedCode !== item.sku.code) {
    return res.status(409).json({ error: "Scanned SKU label does not match the pick list item — wrong item", expected: item.sku.code });
  }
  const updated = await prisma.pickListItem.update({ where: { id: item.id }, data: { status: "SKU_CONFIRMED" } });
  res.json(updated);
});

const confirmSchema = z.object({
  quantity: z.number().int().positive(), // always base-unit (Pcs) — canonical, what stock math uses
  // How the picker actually expressed it (e.g. "2 Box") — display/audit
  // only, doesn't affect `quantity` above. boxesOpened records a deliberate
  // box-break to fulfill a partial-box quantity — see schema.prisma's
  // PickListItem.boxesOpened comment for why this doesn't change the stock
  // math (breaking a box doesn't change the total Pcs count at this
  // location).
  unit: z.string().optional(),
  unitQty: z.number().positive().optional(),
  boxesOpened: z.number().int().min(0).optional(),
});

type PickListItemForClose = Prisma.PickListItemGetPayload<{ include: { sku: true; location: true } }>;

// Shared close-out for a pick list item, whatever quantity actually got
// picked (including 0 — see the /skip route below, which is this same
// mechanism triggered from a different entry point rather than a separate
// code path, per the Skip requirement). A shortfall (qtyToPick - quantity
// > 0) always spins off a follow-up PENDING row for the remainder — the
// same row shape whether it came from a partial pick or a full skip — and
// that follow-up is what /reports/shortfalls surfaces to Sales/Owner.
//
// Follow-up rows are deliberately excluded from the "is this order fully
// loaded" check below: a shortfall/skip on one line shouldn't hold up
// dispatch for lines that picked clean. The follow-up stays open and
// pickable (by anyone, any time — including after the order reaches
// LOADED) rather than being a dead end.
async function closePickItem(
  tx: Prisma.TransactionClient,
  item: PickListItemForClose,
  params: {
    quantity: number;
    unit?: string;
    unitQty?: number;
    boxesOpened?: number;
    userId: string;
    isSkipped: boolean;
    skipReason?: string;
  }
): Promise<{ shortfall: number; orderId: string }> {
  if (params.quantity > 0) {
    await applyStockMovement(tx, {
      skuId: item.skuId,
      locationId: item.locationId,
      batchId: item.batchId,
      quantity: -params.quantity,
      type: "OUTBOUND",
      reason: "Order pick",
      refOrderId: item.orderId,
      userId: params.userId,
    });
  }

  await tx.pickListItem.update({
    where: { id: item.id },
    data: {
      qtyPicked: params.quantity,
      status: "PICKED",
      pickedById: params.userId,
      pickedAt: new Date(),
      pickedUnit: params.unit ?? null,
      pickedUnitQty: params.unitQty ?? null,
      boxesOpened: params.boxesOpened ?? 0,
      isSkipped: params.isSkipped,
      ...(params.isSkipped ? { note: `Issue reported — ${params.skipReason}` } : {}),
    },
  });

  // item.orderLineId directly identifies the line this pick belongs to —
  // looking it up by (orderId, skuId) instead would credit the wrong
  // line's qtyPicked whenever the same SKU appears on more than one line
  // of this order. Legacy rows with no orderLineId (pre-dating this field)
  // fall back to the old lookup rather than crediting nothing.
  if (params.quantity > 0) {
    const orderLine = item.orderLineId
      ? await tx.orderLine.findUnique({ where: { id: item.orderLineId } })
      : await tx.orderLine.findFirst({ where: { orderId: item.orderId, skuId: item.skuId } });
    if (orderLine) {
      await tx.orderLine.update({ where: { id: orderLine.id }, data: { qtyPicked: { increment: params.quantity } } });
    }
  }

  const shortfall = item.qtyToPick - params.quantity;
  if (shortfall > 0) {
    const maxSequence = await tx.pickListItem.aggregate({ where: { orderId: item.orderId }, _max: { sequence: true } });
    await tx.pickListItem.create({
      data: {
        orderId: item.orderId,
        orderLineId: item.orderLineId,
        skuId: item.skuId,
        locationId: item.locationId,
        batchId: item.batchId,
        sequence: (maxSequence._max.sequence ?? item.sequence) + 1,
        qtyToPick: shortfall,
        status: "PENDING",
        isShortfallFollowup: true,
        note: params.isSkipped
          ? `Shortfall follow-up — skipped: ${params.skipReason}`
          : `Shortfall follow-up — only ${params.quantity} of ${item.qtyToPick} ${item.sku.unit} found at ${item.location.code}`,
      },
    });
  }

  const remaining = await tx.pickListItem.count({
    where: { orderId: item.orderId, status: { not: "PICKED" }, isShortfallFollowup: false },
  });
  if (remaining === 0) {
    const order = await tx.order.findUnique({ where: { id: item.orderId }, select: { status: true } });
    if (order?.status === "FINALIZED") {
      await tx.order.update({ where: { id: item.orderId }, data: { status: "LOADED", loadedAt: new Date() } });
    }
  }

  return { shortfall, orderId: item.orderId };
}

pickingRouter.post("/items/:itemId/confirm", requirePermission("inventory.scanPutaway"), async (req: AuthedRequest, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const item = await prisma.pickListItem.findUnique({ where: { id: req.params.itemId }, include: { sku: true, location: true } });
  if (!item) return res.status(404).json({ error: "Pick list item not found" });
  if (item.status === "PICKED") return res.status(409).json({ error: "Item already picked" });
  if (item.status !== "SKU_CONFIRMED") {
    return res.status(409).json({ error: "Scan location and SKU label before confirming quantity" });
  }
  if (parsed.data.quantity > item.qtyToPick) {
    return res.status(400).json({ error: `Cannot pick more than the ${item.qtyToPick} allocated for this item` });
  }

  try {
    const { shortfall, orderId } = await prisma.$transaction((tx) =>
      closePickItem(tx, item, {
        quantity: parsed.data.quantity,
        unit: parsed.data.unit,
        unitQty: parsed.data.unitQty,
        boxesOpened: parsed.data.boxesOpened,
        userId: req.user!.id,
        isSkipped: false,
      })
    );

    if (shortfall > 0) {
      await recordAudit({
        userId: req.user!.id,
        action: "PICK_SHORTFALL",
        entityType: "PickListItem",
        entityId: item.id,
        after: { orderId: item.orderId, skuId: item.skuId, skuCode: item.sku.code, requested: item.qtyToPick, picked: parsed.data.quantity, shortfall },
      });
    }

    await recordAudit({
      userId: req.user!.id,
      action: "PICK_CONFIRM",
      entityType: "PickListItem",
      entityId: item.id,
      after: { quantity: parsed.data.quantity, orderId, boxesOpened: parsed.data.boxesOpened ?? 0 },
    });

    const updated = await prisma.pickListItem.findUnique({ where: { id: item.id } });
    res.json(updated);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
});

const skipSchema = z.object({ reason: z.string().min(1).max(200) });

// Lets a picker move past an item they can't complete right now (out of
// stock, damaged, wrong quantity on the shelf, ...) without getting stuck —
// available at any stage before PICKED, not just from the very first
// "scan location" step, since the blocker can surface at any point in the
// scan/confirm sequence. Functionally a 0-of-N pick for this line (see
// closePickItem): it always leaves a follow-up task behind for the full
// quantity, so the picker (or anyone else) can come back to it later —
// this row itself is done, but the shortfall it created is not.
pickingRouter.post("/items/:itemId/skip", requirePermission("inventory.scanPutaway"), async (req: AuthedRequest, res) => {
  const parsed = skipSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const item = await prisma.pickListItem.findUnique({ where: { id: req.params.itemId }, include: { sku: true, location: true } });
  if (!item) return res.status(404).json({ error: "Pick list item not found" });
  if (item.status === "PICKED") {
    return res.status(409).json({
      error: item.isSkipped ? "This item was already skipped — see its follow-up task in the pick list" : "Item already picked",
    });
  }

  const { orderId } = await prisma.$transaction((tx) =>
    closePickItem(tx, item, { quantity: 0, userId: req.user!.id, isSkipped: true, skipReason: parsed.data.reason })
  );

  await recordAudit({
    userId: req.user!.id,
    action: "PICK_SKIP",
    entityType: "PickListItem",
    entityId: item.id,
    after: { orderId, skuId: item.skuId, skuCode: item.sku.code, qty: item.qtyToPick, reason: parsed.data.reason },
  });
  await recordAudit({
    userId: req.user!.id,
    action: "PICK_SHORTFALL",
    entityType: "PickListItem",
    entityId: item.id,
    after: { orderId, skuId: item.skuId, skuCode: item.sku.code, requested: item.qtyToPick, picked: 0, shortfall: item.qtyToPick },
  });

  const updated = await prisma.pickListItem.findUnique({ where: { id: item.id } });
  res.json(updated);
});
