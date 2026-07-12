import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { PRICE_VISIBLE_ROLES } from "../lib/roles.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

function canSeePrice(role: string) {
  return (PRICE_VISIBLE_ROLES as string[]).includes(role);
}

async function serializeOrder(orderId: string, includePrice: boolean) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      createdBy: { select: { id: true, name: true } },
      lines: {
        include: {
          sku: true,
          ...(includePrice ? { price: true } : {}),
        },
      },
    },
  });
  if (!order) return null;
  return {
    ...order,
    lines: order.lines.map((line: any) => {
      const { price, ...rest } = line;
      return includePrice ? { ...rest, unitPrice: price?.unitPrice ?? null } : rest;
    }),
  };
}

ordersRouter.get("/", async (req: AuthedRequest, res) => {
  const { status } = req.query;
  const orders = await prisma.order.findMany({
    where: typeof status === "string" ? { status } : undefined,
    include: { createdBy: { select: { id: true, name: true } }, lines: { include: { sku: true } } },
    orderBy: { createdAt: "desc" },
  });
  const includePrice = canSeePrice(req.user!.role);
  const serialized = includePrice
    ? await Promise.all(orders.map((o) => serializeOrder(o.id, true)))
    : orders.map((o) => ({ ...o, lines: o.lines.map(({ ...l }) => l) }));
  res.json(serialized);
});

ordersRouter.get("/:id", async (req: AuthedRequest, res) => {
  const order = await serializeOrder(req.params.id, canSeePrice(req.user!.role));
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

const orderLineInput = z.object({
  skuId: z.string().min(1),
  qtyRequested: z.number().int().positive(),
  notes: z.string().optional(),
});

const createOrderSchema = z.object({
  buyerName: z.string().min(1),
  buyerContact: z.string().optional(),
  vehicleCapacityNote: z.string().optional(),
  lines: z.array(orderLineInput).min(1),
});

ordersRouter.post("/", requireRole("OWNER", "SALES"), async (req: AuthedRequest, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;
  const order = await prisma.order.create({
    data: {
      orderNumber,
      buyerName: parsed.data.buyerName,
      buyerContact: parsed.data.buyerContact,
      vehicleCapacityNote: parsed.data.vehicleCapacityNote,
      createdById: req.user!.id,
      lines: { create: parsed.data.lines.map((l) => ({ skuId: l.skuId, qtyRequested: l.qtyRequested, notes: l.notes })) },
    },
    include: { lines: { include: { sku: true } } },
  });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "Order", entityId: order.id, after: order });
  res.status(201).json(order);
});

// Live stock availability check for every line on a draft order — this is
// the fix for pain point #1 (no real-time visibility at order-taking time).
ordersRouter.get("/:id/stock-check", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: { include: { sku: true } } } });
  if (!order) return res.status(404).json({ error: "Order not found" });

  const results = await Promise.all(
    order.lines.map(async (line) => {
      const agg = await prisma.stockItem.aggregate({ where: { skuId: line.skuId }, _sum: { quantity: true } });
      const available = agg._sum.quantity ?? 0;
      const requested = line.qtyFinalized ?? line.qtyRequested;
      return {
        lineId: line.id,
        skuId: line.skuId,
        skuCode: line.sku.code,
        skuName: line.sku.name,
        requested,
        available,
        sufficient: available >= requested,
      };
    })
  );
  res.json(results);
});

const updateLinesSchema = z.object({
  buyerName: z.string().min(1).optional(),
  buyerContact: z.string().optional(),
  vehicleCapacityNote: z.string().optional(),
  lines: z
    .array(
      z.object({
        id: z.string().optional(), // omit to add a new line
        skuId: z.string().min(1).optional(),
        qtyRequested: z.number().int().positive().optional(),
        qtyFinalized: z.number().int().min(0).optional(),
        notes: z.string().optional(),
        remove: z.boolean().optional(),
      })
    )
    .optional(),
});

// Edit a draft order — quantities/items get adjusted here to account for
// vehicle load capacity and actual availability before finalizing.
ordersRouter.patch("/:id", requireRole("OWNER", "SALES"), async (req: AuthedRequest, res) => {
  const parsed = updateLinesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!before) return res.status(404).json({ error: "Order not found" });
  if (before.status !== "DRAFT") {
    return res.status(409).json({ error: "Only draft orders can be edited" });
  }

  await prisma.$transaction(async (tx) => {
    const { lines, ...orderFields } = parsed.data;
    if (Object.keys(orderFields).length > 0) {
      await tx.order.update({ where: { id: before.id }, data: orderFields });
    }
    for (const line of lines ?? []) {
      if (line.id && line.remove) {
        await tx.orderLine.delete({ where: { id: line.id } });
      } else if (line.id) {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { qtyRequested: line.qtyRequested, qtyFinalized: line.qtyFinalized, notes: line.notes },
        });
      } else if (line.skuId && line.qtyRequested) {
        await tx.orderLine.create({ data: { orderId: before.id, skuId: line.skuId, qtyRequested: line.qtyRequested, notes: line.notes } });
      }
    }
  });

  const after = await serializeOrder(before.id, canSeePrice(req.user!.role));
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Order", entityId: before.id, before, after });
  res.json(after);
});

// Finalize: locks in quantities, then allocates each line to specific stock
// locations (largest bin first, to minimize pick stops) and generates a
// pick list grouped/sequenced by location for the loading team.
ordersRouter.post("/:id/finalize", requireRole("OWNER", "SALES"), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "DRAFT") {
    return res.status(409).json({ error: "Only draft orders can be finalized" });
  }

  const shortfalls: { skuId: string; requested: number; available: number }[] = [];

  const result = await prisma.$transaction(async (tx) => {
    const pickListRows: { skuId: string; locationId: string; batchId: string | null; qty: number }[] = [];

    for (const line of order.lines) {
      const qty = line.qtyFinalized ?? line.qtyRequested;
      await tx.orderLine.update({ where: { id: line.id }, data: { qtyFinalized: qty } });
      if (qty === 0) continue;

      const stockItems = await tx.stockItem.findMany({
        where: { skuId: line.skuId, quantity: { gt: 0 } },
        orderBy: { quantity: "desc" },
      });
      const totalAvailable = stockItems.reduce((sum, s) => sum + s.quantity, 0);
      if (totalAvailable < qty) {
        shortfalls.push({ skuId: line.skuId, requested: qty, available: totalAvailable });
        continue;
      }

      let remaining = qty;
      for (const item of stockItems) {
        if (remaining <= 0) break;
        const take = Math.min(item.quantity, remaining);
        pickListRows.push({ skuId: line.skuId, locationId: item.locationId, batchId: item.batchId, qty: take });
        remaining -= take;
      }
    }

    if (shortfalls.length > 0) {
      return { shortfalls };
    }

    // Sequence by location code so the loading team follows one route
    // through the warehouse instead of zig-zagging.
    const locationIds = [...new Set(pickListRows.map((r) => r.locationId))];
    const locations = await tx.location.findMany({ where: { id: { in: locationIds } } });
    const codeById = new Map(locations.map((l) => [l.id, l.code]));
    pickListRows.sort((a, b) => (codeById.get(a.locationId) ?? "").localeCompare(codeById.get(b.locationId) ?? ""));

    await tx.pickListItem.createMany({
      data: pickListRows.map((r, idx) => ({
        orderId: order.id,
        skuId: r.skuId,
        locationId: r.locationId,
        batchId: r.batchId,
        sequence: idx + 1,
        qtyToPick: r.qty,
      })),
    });

    await tx.order.update({ where: { id: order.id }, data: { status: "FINALIZED", finalizedAt: new Date() } });
    return { shortfalls: [] };
  });

  if (result.shortfalls.length > 0) {
    return res.status(409).json({ error: "Insufficient stock to finalize", shortfalls: result.shortfalls });
  }

  await recordAudit({ userId: req.user!.id, action: "FINALIZE", entityType: "Order", entityId: order.id, after: { status: "FINALIZED" } });
  const after = await serializeOrder(order.id, canSeePrice(req.user!.role));
  res.json(after);
});

ordersRouter.post("/:id/cancel", requireRole("OWNER"), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status === "LOADED" || order.status === "INVOICED") {
    return res.status(409).json({ error: "Cannot cancel an order that has already been loaded or invoiced" });
  }
  const updated = await prisma.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
  await recordAudit({ userId: req.user!.id, action: "CANCEL", entityType: "Order", entityId: order.id, before: order, after: updated });
  res.json(updated);
});
