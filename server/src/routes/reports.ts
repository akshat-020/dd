import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { decryptNumber } from "../lib/crypto.js";
import { verifyAuditChain } from "../lib/audit.js";
import { compoundBreakdown } from "../lib/units.js";

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

// Stock-on-hand by SKU and by location, at the current point in time.
// General inventory browsing — excluded from Warehouse's task-scoped view.
//
// StockItem has one row per (sku, location, batch) — receiving the same
// SKU as two separate batches creates two separate StockItem rows even
// though it's physically the same shelf-level quantity from a "how much
// of this do I have" point of view. This aggregates to one row per
// (sku, location) for that top-level view, and keeps the batch-level
// detail (still needed for traceability/FEFO) nested underneath for an
// expandable drill-down rather than fragmenting the main list.
reportsRouter.get("/stock-on-hand", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req, res) => {
  const items = await prisma.stockItem.findMany({
    where: { quantity: { gt: 0 } },
    include: { sku: true, location: true, batch: true },
    orderBy: [{ sku: { name: "asc" } }, { location: { code: "asc" } }],
  });

  const grouped = new Map<
    string,
    {
      skuId: string;
      skuCode: string;
      skuName: string;
      unit: string;
      locationId: string;
      locationCode: string;
      quantity: number;
      batches: { batchId: string | null; batchCode: string | null; receivedDate: string | null; quantity: number }[];
    }
  >();

  for (const i of items) {
    const key = `${i.skuId}|${i.locationId}`;
    const existing = grouped.get(key);
    const batchEntry = {
      batchId: i.batchId,
      batchCode: i.batch?.batchCode ?? null,
      receivedDate: i.batch?.receivedDate?.toISOString() ?? null,
      quantity: i.quantity,
    };
    if (existing) {
      existing.quantity += i.quantity;
      existing.batches.push(batchEntry);
    } else {
      grouped.set(key, {
        skuId: i.skuId,
        skuCode: i.sku.code,
        skuName: i.sku.name,
        unit: i.sku.unit,
        locationId: i.locationId,
        locationCode: i.location.code,
        quantity: i.quantity,
        batches: [batchEntry],
      });
    }
  }

  // Compound breakdown (e.g. "16 Box + 3 pcs") for SKUs with a conversion
  // factor — pure display, computed from the same aggregated quantity.
  const skuById = new Map(items.map((i) => [i.skuId, i.sku]));
  res.json(
    Array.from(grouped.values()).map((row) => ({
      ...row,
      compound: compoundBreakdown(row.quantity, skuById.get(row.skuId)!),
    }))
  );
});

// Order fulfillment turnaround: received -> loaded -> invoiced.
reportsRouter.get("/fulfillment-turnaround", async (_req, res) => {
  const orders = await prisma.order.findMany({
    where: { status: { in: ["LOADED", "INVOICED"] } },
    include: { invoiceReferences: { where: { status: { not: "CANCELLED" } }, orderBy: { createdAt: "asc" }, take: 1 } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(
    orders.map((o) => {
      const invoicedAt = o.invoiceReferences[0]?.createdAt ?? null;
      const minutesToLoad = o.loadedAt ? Math.round((o.loadedAt.getTime() - o.createdAt.getTime()) / 60000) : null;
      const minutesToInvoice = invoicedAt ? Math.round((invoicedAt.getTime() - o.createdAt.getTime()) / 60000) : null;
      return {
        orderId: o.id,
        orderNumber: o.orderNumber,
        buyerName: o.buyerName,
        createdAt: o.createdAt,
        finalizedAt: o.finalizedAt,
        loadedAt: o.loadedAt,
        invoicedAt,
        minutesToLoad,
        minutesToInvoice,
      };
    })
  );
});

// Sales by SKU/buyer/period — includes priced value, so Owner/Accountant only.
reportsRouter.get("/sales", requireRole("OWNER", "ACCOUNTANT"), async (req, res) => {
  const { from, to } = req.query;
  const lines = await prisma.invoiceReferenceLine.findMany({
    where: {
      invoiceReference: {
        status: { not: "CANCELLED" },
        date: {
          gte: typeof from === "string" ? new Date(from) : undefined,
          lte: typeof to === "string" ? new Date(to) : undefined,
        },
      },
    },
    include: { sku: true, invoiceReference: { include: { order: true } } },
  });
  res.json(
    lines.map((l) => {
      const price = decryptNumber(l.price);
      return {
        skuId: l.skuId,
        skuCode: l.sku.code,
        skuName: l.sku.name,
        buyerName: l.invoiceReference.order.buyerName,
        qty: l.qty,
        price,
        value: l.qty * price,
        invoiceDate: l.invoiceReference.date,
        tallyInvoiceNumber: l.invoiceReference.tallyInvoiceNumber,
      };
    })
  );
});

// Discrepancy/audit log: every stock movement, price entry, order edit with
// who/when/what. Restricted to Owner (and Accountant, since they need to
// trace price/invoice discrepancies too).
reportsRouter.get("/audit-log", requireRole("OWNER", "ACCOUNTANT"), async (req: AuthedRequest, res) => {
  const { entityType, limit } = req.query;
  const logs = await prisma.auditLog.findMany({
    where: { entityType: typeof entityType === "string" ? entityType : undefined },
    include: { user: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: "desc" },
    take: typeof limit === "string" ? Math.min(Number(limit) || 200, 1000) : 200,
  });
  res.json(logs);
});

// Recomputes the tamper-evident hash chain and reports whether it's intact
// — lets an Owner periodically confirm the audit trail hasn't been altered
// by anything other than this application's own append-only writes.
reportsRouter.get("/audit-log/verify", requireRole("OWNER"), async (_req, res) => {
  const result = await verifyAuditChain();
  res.json(result);
});

// Unresolved picking shortfalls — the in-app equivalent of "notify Sales
// staff/Owner of the shortfall" (there's no email/SMS service configured;
// see README). A shortfall counts as resolved once its follow-up task is
// itself picked, or once the order is no longer active.
reportsRouter.get("/shortfalls", requireRole("OWNER", "SALES"), async (_req, res) => {
  const items = await prisma.pickListItem.findMany({
    where: { isShortfallFollowup: true, status: { not: "PICKED" } },
    include: { sku: true, location: true, order: { select: { id: true, orderNumber: true, buyerName: true, status: true } } },
    orderBy: { id: "desc" },
  });
  res.json(
    items
      .filter((i) => i.order.status !== "CANCELLED")
      .map((i) => ({
        pickListItemId: i.id,
        orderId: i.order.id,
        orderNumber: i.order.orderNumber,
        buyerName: i.order.buyerName,
        skuId: i.skuId,
        skuCode: i.sku.code,
        skuName: i.sku.name,
        locationCode: i.location.code,
        shortfallQty: i.qtyToPick,
        note: i.note,
      }))
  );
});

// A warehouse account's own recently completed work — picks and putaways —
// so they can answer "did I pick that?" without needing general order or
// stock-browsing access (per the permission model's task-scoped visibility).
reportsRouter.get("/my-task-history", async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  const [picks, putaways] = await Promise.all([
    prisma.pickListItem.findMany({
      where: { pickedById: userId, status: "PICKED" },
      include: { sku: true, location: true, order: { select: { orderNumber: true } } },
      orderBy: { pickedAt: "desc" },
      take: 50,
    }),
    prisma.stockMovement.findMany({
      where: { userId, type: "INBOUND", reason: "Putaway" },
      include: { sku: true, location: true, batch: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  res.json({
    picks: picks.map((p) => ({
      id: p.id,
      skuCode: p.sku.code,
      skuName: p.sku.name,
      locationCode: p.location.code,
      qty: p.qtyPicked,
      orderNumber: p.order.orderNumber,
      pickedAt: p.pickedAt,
    })),
    putaways: putaways.map((m) => ({
      id: m.id,
      skuCode: m.sku.code,
      skuName: m.sku.name,
      locationCode: m.location.code,
      batchCode: m.batch?.batchCode ?? null,
      qty: m.quantity,
      createdAt: m.createdAt,
    })),
  });
});
