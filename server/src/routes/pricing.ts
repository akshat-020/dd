import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAnyPermission, requireAllPermissions, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { encryptNumber, decryptNumber } from "../lib/crypto.js";
import { skuDefaultPriceForUnit } from "../lib/pricing.js";

// Mounted at /api/orders. Reading (GET) only needs to be useful to whoever
// is about to use it for one of the two financial document types, so
// either permission is enough there. WRITING is different: this is the
// order's single canonical price, which either document type can read —
// holding only one of the two specific permissions must not be enough to
// set it, or that account could write pricing data whose downstream use
// (the other document type) it's explicitly not authorized for. See
// PermissionEnforcementGap fix: an account with only pricing.managePI
// (not pricing.manageInvoiceReference) was previously able to save order
// pricing here despite being correctly blocked from creating an Invoice
// Reference — both now require the full set.
export const pricingRouter = Router();

pricingRouter.use(requireAuth);

pricingRouter.get("/:id/pricing", requireAnyPermission("pricing.manageInvoiceReference", "pricing.managePI"), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: { lines: { include: { sku: true, price: true } } },
  });
  if (!order) return res.status(404).json({ error: "Order not found" });

  res.json({
    orderId: order.id,
    orderNumber: order.orderNumber,
    lines: order.lines.map((l) => {
      const unit = l.finalUnit ?? l.requestedUnit ?? null;
      return {
        lineId: l.id,
        skuId: l.skuId,
        skuCode: l.sku.code,
        skuName: l.sku.name,
        qty: l.qtyFinalized ?? l.qtyRequested, // base unit — canonical
        // How this line was actually placed (e.g. "5 Box") — null means base
        // unit already. Pricing/billing applies per 1 of this unit, not the
        // base unit, since box/bulk pricing carries its own margin.
        unit,
        unitQty: l.finalUnitQty ?? l.requestedUnitQty ?? null,
        unitPrice: l.price ? decryptNumber(l.price.unitPrice) : null,
        defaultUnitPrice: skuDefaultPriceForUnit(l.sku, unit),
      };
    }),
  });
});

const setPricingSchema = z.object({
  lines: z.array(z.object({ lineId: z.string().min(1), unitPrice: z.number().nonnegative() })).min(1),
});

pricingRouter.put("/:id/pricing", requireAllPermissions("pricing.manageInvoiceReference", "pricing.managePI"), async (req: AuthedRequest, res) => {
  const parsed = setPricingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  const lineIds = new Set(order.lines.map((l) => l.id));

  await prisma.$transaction(async (tx) => {
    for (const line of parsed.data.lines) {
      if (!lineIds.has(line.lineId)) continue;
      const encrypted = encryptNumber(line.unitPrice);
      await tx.orderLinePrice.upsert({
        where: { orderLineId: line.lineId },
        update: { unitPrice: encrypted, updatedById: req.user!.id },
        create: { orderLineId: line.lineId, unitPrice: encrypted, updatedById: req.user!.id },
      });
    }
  });

  await recordAudit({ userId: req.user!.id, action: "SET_PRICING", entityType: "Order", entityId: order.id, after: parsed.data.lines });

  const updated = await prisma.order.findUnique({ where: { id: order.id }, include: { lines: { include: { sku: true, price: true } } } });
  res.json({
    orderId: updated!.id,
    lines: updated!.lines.map((l) => ({ lineId: l.id, skuId: l.skuId, skuCode: l.sku.code, unitPrice: l.price ? decryptNumber(l.price.unitPrice) : null })),
  });
});
