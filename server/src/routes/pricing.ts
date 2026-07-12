import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";

// Mounted at /api/orders — everything here is Owner/Accountant-only at the
// route level (requireRole below), which is the server-side enforcement the
// brief calls for ("inaccessible at the API level, not just hidden in the UI").
export const pricingRouter = Router();

pricingRouter.use(requireAuth);

pricingRouter.get("/:id/pricing", requireRole("OWNER", "ACCOUNTANT"), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { lines: { include: { sku: true, price: true } } },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  res.json({
    orderId: order.id,
    orderNumber: order.orderNumber,
    lines: order.lines.map((l) => ({
      lineId: l.id,
      skuId: l.skuId,
      skuCode: l.sku.code,
      skuName: l.sku.name,
      qty: l.qtyFinalized ?? l.qtyRequested,
      unitPrice: l.price?.unitPrice ?? null,
    })),
  });
});

const setPricingSchema = z.object({
  lines: z.array(z.object({ lineId: z.string().min(1), unitPrice: z.number().nonnegative() })).min(1),
});

pricingRouter.put("/:id/pricing", requireRole("OWNER", "ACCOUNTANT"), async (req: AuthedRequest, res) => {
  const parsed = setPricingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  const lineIds = new Set(order.lines.map((l) => l.id));

  await prisma.$transaction(async (tx) => {
    for (const line of parsed.data.lines) {
      if (!lineIds.has(line.lineId)) continue;
      await tx.orderLinePrice.upsert({
        where: { orderLineId: line.lineId },
        update: { unitPrice: line.unitPrice, updatedById: req.user!.id },
        create: { orderLineId: line.lineId, unitPrice: line.unitPrice, updatedById: req.user!.id },
      });
    }
  });

  await recordAudit({ userId: req.user!.id, action: "SET_PRICING", entityType: "Order", entityId: order.id, after: parsed.data.lines });

  const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { lines: { include: { sku: true, price: true } } } });
  res.json({
    orderId: updated!.id,
    lines: updated!.lines.map((l) => ({ lineId: l.id, skuId: l.skuId, skuCode: l.sku.code, unitPrice: l.price?.unitPrice ?? null })),
  });
});
