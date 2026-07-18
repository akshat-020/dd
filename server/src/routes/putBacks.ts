import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { applyStockMovement } from "../lib/stock.js";

// Round-4 operational-flow addendum, item 4: when a Final Qty reduction
// after picking creates a PutBackTask (see reconcileOrderLineAllocation),
// this is where a warehouse account physically confirms the return — same
// scan-based confirmation pattern as putaway.
export const putBacksRouter = Router();

putBacksRouter.use(requireAuth);

putBacksRouter.get("/", requirePermission("inventory.scanPutaway"), async (_req, res) => {
  const tasks = await prisma.putBackTask.findMany({
    where: { status: "PENDING" },
    include: {
      sku: true,
      fromLocation: true,
      order: { select: { id: true, orderNumber: true, buyerName: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  res.json(tasks);
});

const confirmSchema = z.object({
  // Defaults to the originally-picked-from location if omitted — the
  // system's suggested best-fit, per the addendum — but a warehouse
  // account can put it back somewhere else (mirrors putaway's own
  // scan/select destination flexibility).
  locationId: z.string().min(1).optional(),
});

putBacksRouter.post("/:id/confirm", requirePermission("inventory.scanPutaway"), async (req: AuthedRequest, res) => {
  const parsed = confirmSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const task = await prisma.putBackTask.findUnique({ where: { id: req.params.id }, include: { sku: true, fromLocation: true } });
  if (!task) return res.status(404).json({ error: "Put-back task not found" });
  if (task.status !== "PENDING") return res.status(409).json({ error: "This put-back has already been confirmed" });

  const destinationLocationId = parsed.data.locationId ?? task.fromLocationId;
  const destination = await prisma.location.findUnique({ where: { id: destinationLocationId } });
  if (!destination) return res.status(404).json({ error: "Destination location not found" });

  await prisma.$transaction(async (tx) => {
    await applyStockMovement(tx, {
      skuId: task.skuId,
      locationId: destinationLocationId,
      batchId: task.batchId,
      quantity: task.quantity,
      type: "INBOUND",
      reason: "Put-back",
      refOrderId: task.orderId,
      userId: req.user!.id,
    });

    // Reconcile the source pick's qtyPicked (and the order line's rollup)
    // down to match — this is the point where the "in limbo" quantity
    // stops being counted as picked and becomes shelved again.
    const sourceItem = await tx.pickListItem.update({
      where: { id: task.sourcePickListItemId },
      data: { qtyPicked: { decrement: task.quantity } },
    });
    await tx.orderLine.update({ where: { id: task.orderLineId }, data: { qtyPicked: { decrement: task.quantity } } });

    await tx.putBackTask.update({
      where: { id: task.id },
      data: { status: "CONFIRMED", toLocationId: destinationLocationId, confirmedById: req.user!.id, confirmedAt: new Date() },
    });

    return sourceItem;
  });

  await recordAudit({
    userId: req.user!.id,
    action: "PUT_BACK_CONFIRM",
    entityType: "PutBackTask",
    entityId: task.id,
    after: { orderId: task.orderId, skuId: task.skuId, skuCode: task.sku.code, quantity: task.quantity, toLocationId: destinationLocationId },
  });

  const updated = await prisma.putBackTask.findUnique({ where: { id: task.id } });
  res.json(updated);
});
