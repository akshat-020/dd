import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { PRICE_VISIBLE_ROLES } from "../lib/roles.js";
import { decryptNumber } from "../lib/crypto.js";
import { getCommittedQuantities, reconcileOrderLineAllocation, ShortfallError } from "../lib/stock.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

function canSeePrice(role: string) {
  return (PRICE_VISIBLE_ROLES as string[]).includes(role);
}

// A DRAFT order is a not-yet-committed conversation with a buyer — visible
// only to whoever created it (plus Owner, consistent with Owner's
// unrestricted access everywhere else). Once finalized it's no longer a
// private draft, so every other role's existing access resumes as before.
function canAccessOrder(user: { id: string; role: string }, order: { status: string; createdById: string }) {
  if (order.status !== "DRAFT") return true;
  return user.role === "OWNER" || order.createdById === user.id;
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
      return includePrice ? { ...rest, unitPrice: price ? decryptNumber(price.unitPrice) : null } : rest;
    }),
  };
}

// General order browsing is excluded from Warehouse's task-scoped
// visibility — their view is entirely /api/picking/* (which never touches
// this router), plus /api/reports/my-task-history for their own completed
// work. See the permission model addendum.
ordersRouter.get("/", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req: AuthedRequest, res) => {
  const { status } = req.query;
  const { id: userId, role } = req.user!;

  // Draft orders are scoped to their creator (+ Owner) at the query level,
  // not filtered out afterward — see canAccessOrder above.
  const statusFilter = typeof status === "string" ? status : undefined;
  let where: Record<string, unknown>;
  if (role === "OWNER") {
    where = statusFilter ? { status: statusFilter } : {};
  } else if (statusFilter === "DRAFT") {
    where = { status: "DRAFT", createdById: userId };
  } else if (statusFilter) {
    where = { status: statusFilter };
  } else {
    where = { OR: [{ status: { not: "DRAFT" } }, { createdById: userId }] };
  }

  const orders = await prisma.order.findMany({
    where,
    include: { createdBy: { select: { id: true, name: true } }, lines: { include: { sku: true } } },
    orderBy: { createdAt: "desc" },
  });
  const includePrice = canSeePrice(role);
  const serialized = includePrice
    ? await Promise.all(orders.map((o) => serializeOrder(o.id, true)))
    : orders.map((o) => ({ ...o, lines: o.lines.map(({ ...l }) => l) }));
  res.json(serialized);
});

ordersRouter.get("/:id", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req: AuthedRequest, res) => {
  const raw = await prisma.order.findUnique({ where: { id: req.params.id }, select: { status: true, createdById: true } });
  if (!raw || !canAccessOrder(req.user!, raw)) return res.status(404).json({ error: "Order not found" });
  const order = await serializeOrder(req.params.id, canSeePrice(req.user!.role));
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

// Live stock availability check for every line on a draft order. `available`
// is on-hand stock minus whatever's already committed to *other* orders
// (other open drafts' requested qty, other finalized-but-not-yet-picked
// orders' pick-list qty) — checking against raw on-hand alone lets two
// orders both get told a SKU is available when there's really only enough
// for one (see getCommittedQuantities in lib/stock.ts).
ordersRouter.get("/:id/stock-check", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: { include: { sku: true } } } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!canAccessOrder(req.user!, order)) return res.status(404).json({ error: "Order not found" });

  const skuIds = order.lines.map((l) => l.skuId);
  const [stockAgg, committed] = await Promise.all([
    prisma.stockItem.groupBy({ by: ["skuId"], where: { skuId: { in: skuIds } }, _sum: { quantity: true } }),
    getCommittedQuantities(prisma, skuIds, order.id),
  ]);
  const onHandBySku = new Map(stockAgg.map((g) => [g.skuId, g._sum.quantity ?? 0]));

  const results = order.lines.map((line) => {
    const onHand = onHandBySku.get(line.skuId) ?? 0;
    const committedElsewhere = committed.get(line.skuId) ?? 0;
    const available = Math.max(onHand - committedElsewhere, 0);
    const requested = line.qtyFinalized ?? line.qtyRequested;
    return {
      lineId: line.id,
      skuId: line.skuId,
      skuCode: line.sku.code,
      skuName: line.sku.name,
      requested,
      available,
      committedElsewhere,
      sufficient: available >= requested,
    };
  });
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
        qtyRequested: z.number().int().positive().optional(), // only used when adding a new line — see below
        qtyFinalized: z.number().int().min(0).optional(),
        notes: z.string().optional(),
        remove: z.boolean().optional(),
      })
    )
    .optional(),
});

// Edit an order. Requested qty is the original ask and is locked the
// moment a line exists — this endpoint only ever writes qtyRequested when
// *creating* a new line (no `id`); an existing line's `qtyRequested` in the
// payload is ignored. Final Qty (qtyFinalized) is the one editable
// quantity field, and it's what actually drives stock allocation.
//
// Editable while DRAFT (no PickListItems exist yet, so this is a plain
// field update) or FINALIZED (up to the point loading is complete —
// LOADED/INVOICED/CANCELLED are locked). Editing a FINALIZED order's
// quantities reconciles the pick list allocation immediately
// (reconcileOrderLineAllocation) so nothing about location assignments
// goes stale; by the time an order can be INVOICED it's already past
// LOADED, which is locked, so the Invoice Reference layer can never see a
// post-invoice edit in the first place.
ordersRouter.patch("/:id", requireRole("OWNER", "SALES"), async (req: AuthedRequest, res) => {
  const parsed = updateLinesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!before || !canAccessOrder(req.user!, before)) return res.status(404).json({ error: "Order not found" });
  if (before.status !== "DRAFT" && before.status !== "FINALIZED") {
    return res.status(409).json({ error: "Only draft or finalized (not yet loaded) orders can be edited" });
  }
  const isFinalized = before.status === "FINALIZED";

  try {
    await prisma.$transaction(async (tx) => {
      const { lines, ...orderFields } = parsed.data;
      if (Object.keys(orderFields).length > 0) {
        await tx.order.update({ where: { id: before.id }, data: orderFields });
      }
      for (const line of lines ?? []) {
        if (line.id && line.remove) {
          const existing = before.lines.find((l) => l.id === line.id);
          if (!existing) continue;
          if (isFinalized) {
            if (existing.qtyPicked > 0) {
              throw new Error(`Cannot remove ${existing.skuId} — it's already been partially or fully picked`);
            }
            await tx.pickListItem.deleteMany({ where: { orderId: before.id, skuId: existing.skuId, status: { not: "PICKED" } } });
          }
          await tx.orderLine.delete({ where: { id: line.id } });
        } else if (line.id) {
          const existing = before.lines.find((l) => l.id === line.id);
          if (!existing) continue;
          if (isFinalized && line.qtyFinalized !== undefined) {
            await reconcileOrderLineAllocation(tx, { orderId: before.id, skuId: existing.skuId, newQty: line.qtyFinalized });
          }
          await tx.orderLine.update({ where: { id: line.id }, data: { qtyFinalized: line.qtyFinalized, notes: line.notes } });
        } else if (line.skuId && line.qtyRequested) {
          const newLine = await tx.orderLine.create({
            data: {
              orderId: before.id,
              skuId: line.skuId,
              qtyRequested: line.qtyRequested,
              qtyFinalized: isFinalized ? line.qtyRequested : undefined,
              notes: line.notes,
            },
          });
          if (isFinalized) {
            await reconcileOrderLineAllocation(tx, { orderId: before.id, skuId: newLine.skuId, newQty: line.qtyRequested });
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof ShortfallError) {
      return res.status(409).json({ error: err.message, skuId: err.skuId, requested: err.requested, available: err.available });
    }
    if (err instanceof Error) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }

  const after = await serializeOrder(before.id, canSeePrice(req.user!.role));
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Order", entityId: before.id, before, after });
  res.json(after);
});

// Finalize: locks in quantities, then allocates each line to specific stock
// locations (largest bin first, to minimize pick stops) and generates a
// pick list grouped/sequenced by location for the loading team.
ordersRouter.post("/:id/finalize", requireRole("OWNER", "SALES"), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!order || !canAccessOrder(req.user!, order)) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "DRAFT") {
    return res.status(409).json({ error: "Only draft orders can be finalized" });
  }

  const shortfalls: { skuId: string; requested: number; available: number }[] = [];

  const result = await prisma.$transaction(async (tx) => {
    const pickListRows: { skuId: string; locationId: string; batchId: string | null; qty: number }[] = [];
    // Same commitment accounting as the stock-check endpoint — without this,
    // two orders finalizing around the same time could each see the full
    // physical on-hand quantity and both succeed, oversubscribing the same
    // stock (finalize only *allocates* to specific bins; the actual
    // StockItem deduction doesn't happen until the physical pick-confirm
    // scan, so on-hand alone isn't the truth at this point).
    const committed = await getCommittedQuantities(
      tx,
      order.lines.map((l) => l.skuId),
      order.id
    );

    for (const line of order.lines) {
      const qty = line.qtyFinalized ?? line.qtyRequested;
      await tx.orderLine.update({ where: { id: line.id }, data: { qtyFinalized: qty } });
      if (qty === 0) continue;

      const stockItems = await tx.stockItem.findMany({
        where: { skuId: line.skuId, quantity: { gt: 0 } },
        orderBy: { quantity: "desc" },
      });
      const totalOnHand = stockItems.reduce((sum, s) => sum + s.quantity, 0);
      const committedElsewhere = committed.get(line.skuId) ?? 0;
      const trulyAvailable = totalOnHand - committedElsewhere;
      if (trulyAvailable < qty) {
        shortfalls.push({ skuId: line.skuId, requested: qty, available: Math.max(trulyAvailable, 0) });
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
