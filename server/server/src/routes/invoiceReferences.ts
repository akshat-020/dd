import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { applyStockMovement } from "../lib/stock.js";

// Owner/Accountant-only layer that links an order to the actual invoice
// created in Tally, without replacing Tally as the invoice system of record.
export const invoiceReferencesRouter = Router();

invoiceReferencesRouter.use(requireAuth, requireRole("OWNER", "ACCOUNTANT"));

invoiceReferencesRouter.get("/order/:orderId", async (req, res) => {
  const refs = await prisma.invoiceReference.findMany({
    where: { orderId: req.params.orderId },
    include: { lines: { include: { sku: true } }, createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  res.json(refs);
});

invoiceReferencesRouter.get("/:id", async (req, res) => {
  const ref = await prisma.invoiceReference.findUnique({
    where: { id: req.params.id },
    include: { lines: { include: { sku: true } }, order: true, createdBy: { select: { id: true, name: true } } },
  });
  if (!ref) return res.status(404).json({ error: "Invoice reference not found" });
  res.json(ref);
});

const createSchema = z.object({
  tallyInvoiceNumber: z.string().min(1),
  orderId: z.string().min(1),
  date: z.string().datetime().optional(),
  lines: z.array(z.object({ skuId: z.string().min(1), qty: z.number().int().positive(), price: z.number().nonnegative() })).min(1),
});

// Add Invoice Reference: attaches the Tally invoice number to the order and
// its priced lines. Does not touch stock — dispatch/loading already did that.
invoiceReferencesRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  const existing = await prisma.invoiceReference.findUnique({ where: { tallyInvoiceNumber: parsed.data.tallyInvoiceNumber } });
  if (existing) return res.status(409).json({ error: "This Tally invoice number is already referenced" });

  const ref = await prisma.invoiceReference.create({
    data: {
      tallyInvoiceNumber: parsed.data.tallyInvoiceNumber,
      orderId: parsed.data.orderId,
      date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
      createdById: req.user!.id,
      lines: { create: parsed.data.lines.map((l) => ({ skuId: l.skuId, qty: l.qty, price: l.price })) },
    },
    include: { lines: true },
  });

  if (order.status === "LOADED") {
    await prisma.order.update({ where: { id: order.id }, data: { status: "INVOICED" } });
  }

  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "InvoiceReference", entityId: ref.id, after: ref });
  res.status(201).json(ref);
});

const cancelSchema = z.object({ reverseStock: z.boolean().default(false) });

// Cancel Invoice Reference. If goods were actually returned, reverses the
// original dispatch deduction back to the location(s) it was picked from.
// If it's paperwork-only (e.g. wrong invoice number), just voids the
// reference without touching stock.
invoiceReferencesRouter.post("/:id/cancel", async (req: AuthedRequest, res) => {
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const ref = await prisma.invoiceReference.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!ref) return res.status(404).json({ error: "Invoice reference not found" });
  if (ref.status === "CANCELLED") return res.status(409).json({ error: "Already cancelled" });

  await prisma.$transaction(async (tx) => {
    if (parsed.data.reverseStock) {
      for (const line of ref.lines) {
        const pickItems = await tx.pickListItem.findMany({
          where: { orderId: ref.orderId, skuId: line.skuId, status: "PICKED" },
        });
        let remaining = line.qty;
        for (const item of pickItems) {
          if (remaining <= 0) break;
          const restore = Math.min(item.qtyPicked, remaining);
          if (restore <= 0) continue;
          await applyStockMovement(tx, {
            skuId: line.skuId,
            locationId: item.locationId,
            batchId: item.batchId,
            quantity: restore,
            type: "ADJUSTMENT",
            reason: "Invoice cancelled — goods returned",
            refInvoiceRefId: ref.id,
            refOrderId: ref.orderId,
            userId: req.user!.id,
          });
          remaining -= restore;
        }
      }
    }
    await tx.invoiceReference.update({ where: { id: ref.id }, data: { status: "CANCELLED" } });
  });

  await recordAudit({
    userId: req.user!.id,
    action: "CANCEL",
    entityType: "InvoiceReference",
    entityId: ref.id,
    before: ref,
    after: { status: "CANCELLED", reverseStock: parsed.data.reverseStock },
  });
  const updated = await prisma.invoiceReference.findUnique({ where: { id: ref.id }, include: { lines: true } });
  res.json(updated);
});

const adjustSchema = z.object({
  lines: z.array(z.object({ invoiceLineId: z.string().min(1), qty: z.number().int().positive().optional(), price: z.number().nonnegative().optional() })).min(1),
});

// Adjust Invoice Reference: edits a line's qty/price (e.g. billed weight
// differs from dispatched weight) and posts an adjustment stock movement
// tagged with the invoice number so the audit trail shows why the number
// changed.
invoiceReferencesRouter.post("/:id/adjust", async (req: AuthedRequest, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const ref = await prisma.invoiceReference.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!ref) return res.status(404).json({ error: "Invoice reference not found" });
  if (ref.status === "CANCELLED") return res.status(409).json({ error: "Cannot adjust a cancelled invoice reference" });

  await prisma.$transaction(async (tx) => {
    for (const update of parsed.data.lines) {
      const existingLine = ref.lines.find((l) => l.id === update.invoiceLineId);
      if (!existingLine) continue;

      const newQty = update.qty ?? existingLine.qty;
      const qtyDelta = existingLine.qty - newQty; // positive = billed qty went down -> stock returned

      if (qtyDelta !== 0) {
        const pickItem = await tx.pickListItem.findFirst({ where: { orderId: ref.orderId, skuId: existingLine.skuId, status: "PICKED" } });
        if (pickItem) {
          await applyStockMovement(tx, {
            skuId: existingLine.skuId,
            locationId: pickItem.locationId,
            batchId: pickItem.batchId,
            quantity: qtyDelta,
            type: "ADJUSTMENT",
            reason: `Invoice ${ref.tallyInvoiceNumber} adjustment`,
            refInvoiceRefId: ref.id,
            refOrderId: ref.orderId,
            userId: req.user!.id,
            allowNegative: true,
          });
        }
      }

      await tx.invoiceReferenceLine.update({
        where: { id: existingLine.id },
        data: { qty: newQty, price: update.price ?? existingLine.price },
      });
    }
    await tx.invoiceReference.update({ where: { id: ref.id }, data: { status: "ADJUSTED" } });
  });

  await recordAudit({ userId: req.user!.id, action: "ADJUST", entityType: "InvoiceReference", entityId: ref.id, before: ref, after: parsed.data });
  const updated = await prisma.invoiceReference.findUnique({ where: { id: ref.id }, include: { lines: true } });
  res.json(updated);
});
