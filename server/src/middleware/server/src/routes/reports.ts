import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { decryptNumber } from "../lib/crypto.js";
import { verifyAuditChain } from "../lib/audit.js";

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

// Stock-on-hand by SKU and by location, at the current point in time.
// General inventory browsing — excluded from Warehouse's task-scoped view.
reportsRouter.get("/stock-on-hand", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req, res) => {
  const items = await prisma.stockItem.findMany({
    where: { quantity: { gt: 0 } },
    include: { sku: true, location: true },
    orderBy: [{ sku: { name: "asc" } }, { location: { code: "asc" } }],
  });
  res.json(
    items.map((i) => ({
      skuId: i.skuId,
      skuCode: i.sku.code,
      skuName: i.sku.name,
      unit: i.sku.unit,
      locationId: i.locationId,
      locationCode: i.location.code,
      quantity: i.quantity,
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
