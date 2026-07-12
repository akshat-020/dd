import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { applyStockMovement, InsufficientStockError } from "../lib/stock.js";

export const pickingRouter = Router();

pickingRouter.use(requireAuth);

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

pickingRouter.post("/items/:itemId/scan-location", requireRole("OWNER", "WAREHOUSE"), async (req, res) => {
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

pickingRouter.post("/items/:itemId/scan-sku", requireRole("OWNER", "WAREHOUSE"), async (req, res) => {
  const parsed = scanSkuSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const item = await prisma.pickListItem.findUnique({ where: { id: req.params.itemId }, include: { sku: true } });
  if (!item) return res.status(404).json({ error: "Pick list item not found" });
  if (item.status === "PICKED") return res.status(409).json({ error: "Item already picked" });
  if (item.status === "PENDING") {
    return res.status(409).json({ error: "Scan the location QR before scanning the SKU label" });
  }

  const skuMatch = /SKU:([^|]+)/.exec(parsed.data.label);
  if (!skuMatch || skuMatch[1] !== item.sku.code) {
    return res.status(409).json({ error: "Scanned SKU label does not match the pick list item — wrong item", expected: item.sku.code });
  }
  const updated = await prisma.pickListItem.update({ where: { id: item.id }, data: { status: "SKU_CONFIRMED" } });
  res.json(updated);
});

const confirmSchema = z.object({ quantity: z.number().int().positive() });

pickingRouter.post("/items/:itemId/confirm", requireRole("OWNER", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const item = await prisma.pickListItem.findUnique({ where: { id: req.params.itemId } });
  if (!item) return res.status(404).json({ error: "Pick list item not found" });
  if (item.status === "PICKED") return res.status(409).json({ error: "Item already picked" });
  if (item.status !== "SKU_CONFIRMED") {
    return res.status(409).json({ error: "Scan location and SKU label before confirming quantity" });
  }
  if (parsed.data.quantity > item.qtyToPick) {
    return res.status(400).json({ error: `Cannot pick more than the ${item.qtyToPick} allocated for this item` });
  }

  try {
    const orderId = await prisma.$transaction(async (tx) => {
      await applyStockMovement(tx, {
        skuId: item.skuId,
        locationId: item.locationId,
        batchId: item.batchId,
        quantity: -parsed.data.quantity,
        type: "OUTBOUND",
        reason: "Order pick",
        refOrderId: item.orderId,
        userId: req.user!.id,
      });
      await tx.pickListItem.update({
        where: { id: item.id },
        data: { qtyPicked: parsed.data.quantity, status: "PICKED", pickedById: req.user!.id, pickedAt: new Date() },
      });

      const orderLine = await tx.orderLine.findFirst({ where: { orderId: item.orderId, skuId: item.skuId } });
      if (orderLine) {
        await tx.orderLine.update({ where: { id: orderLine.id }, data: { qtyPicked: { increment: parsed.data.quantity } } });
      }

      const remaining = await tx.pickListItem.count({ where: { orderId: item.orderId, status: { not: "PICKED" } } });
      if (remaining === 0) {
        await tx.order.update({ where: { id: item.orderId }, data: { status: "LOADED", loadedAt: new Date() } });
      }
      return item.orderId;
    });

    await recordAudit({
      userId: req.user!.id,
      action: "PICK_CONFIRM",
      entityType: "PickListItem",
      entityId: item.id,
      after: { quantity: parsed.data.quantity, orderId },
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
