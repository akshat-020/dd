import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, requireScanAccess, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { generateQrPngBuffer, generateQrSvg, encodeSkuBatchLabel } from "../lib/qr.js";
import { applyStockMovement, InsufficientStockError } from "../lib/stock.js";

export const stockRouter = Router();

stockRouter.use(requireAuth);

// ---- Batches (self-printed SKU labels: SKU + batch/lot + date) ----

const createBatchSchema = z.object({
  skuId: z.string().min(1),
  batchCode: z.string().min(1).optional(),
  sourceType: z.enum(["PURCHASE", "PRODUCTION"]),
  note: z.string().optional(),
});

// Logged at the moment of purchase/production receipt. Auto-generates a
// batch code if the caller doesn't supply one, so a warehouse worker can
// just tap "Receive" without typing.
stockRouter.post("/batches", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = createBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const sku = await prisma.sku.findUnique({ where: { id: parsed.data.skuId } });
  if (!sku) return res.status(404).json({ error: "SKU not found" });

  const batchCode = parsed.data.batchCode ?? `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const batch = await prisma.skuBatch.create({
    data: { skuId: parsed.data.skuId, batchCode, sourceType: parsed.data.sourceType, note: parsed.data.note },
  });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "SkuBatch", entityId: batch.id, after: batch });
  res.status(201).json(batch);
});

// Batch/QR history for a SKU — lets Owner/Accountant/Sales view or reprint
// the label for any past batch, not just the one just created on the
// Receiving screen (which only showed its QR transiently).
stockRouter.get("/batches", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req, res) => {
  const { skuId } = req.query;
  if (typeof skuId !== "string") {
    return res.status(400).json({ error: "skuId query param is required" });
  }
  const batches = await prisma.skuBatch.findMany({
    where: { skuId },
    orderBy: { receivedDate: "desc" },
  });
  res.json(batches);
});

stockRouter.get("/batches/:id", async (req, res) => {
  const batch = await prisma.skuBatch.findUnique({ where: { id: req.params.id }, include: { sku: true } });
  if (!batch) return res.status(404).json({ error: "Batch not found" });
  res.json(batch);
});

stockRouter.get("/batches/:id/qr", async (req, res) => {
  const batch = await prisma.skuBatch.findUnique({ where: { id: req.params.id }, include: { sku: true } });
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  const label = encodeSkuBatchLabel(batch.sku.code, batch.batchCode, batch.receivedDate.toISOString());
  if (req.query.format === "svg") {
    res.type("image/svg+xml").send(await generateQrSvg(label));
    return;
  }
  res.type("image/png").send(await generateQrPngBuffer(label));
});

// Resolve a scanned SKU-label QR payload ("SKU:code|BATCH:code|DATE:...")
// back to the sku/batch records, for the scan-to-confirm picking/putaway UI.
stockRouter.get("/batches/resolve/:label", async (req, res) => {
  const label = decodeURIComponent(req.params.label);
  const skuMatch = /SKU:([^|]+)/.exec(label);
  const batchMatch = /BATCH:([^|]+)/.exec(label);
  if (!skuMatch || !batchMatch) return res.status(400).json({ error: "Unrecognized SKU label format" });

  const sku = await prisma.sku.findUnique({ where: { code: skuMatch[1] } });
  if (!sku) return res.status(404).json({ error: "SKU not found for label" });
  const batch = await prisma.skuBatch.findUnique({ where: { skuId_batchCode: { skuId: sku.id, batchCode: batchMatch[1] } } });
  if (!batch) return res.status(404).json({ error: "Batch not found for label" });

  res.json({ sku, batch });
});

// ---- Stock queries ----

// General stock browsing is deliberately NOT available to Warehouse staff —
// their visibility is task-scoped to whatever pick list/putaway they're
// actively working (see /api/picking/* and the putaway flow), per the
// permission model. Owner/Accountant/Sales keep full, non-task-scoped access.
stockRouter.get("/", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req, res) => {
  const { skuId, locationId } = req.query;
  const items = await prisma.stockItem.findMany({
    where: {
      skuId: typeof skuId === "string" ? skuId : undefined,
      locationId: typeof locationId === "string" ? locationId : undefined,
      quantity: { gt: 0 },
    },
    include: { sku: true, location: true, batch: true },
    orderBy: [{ sku: { name: "asc" } }],
  });
  res.json(items);
});

// "Where is SKU X right now" — the direct fix for pain point #2.
stockRouter.get("/sku/:skuId/locations", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req, res) => {
  const items = await prisma.stockItem.findMany({
    where: { skuId: req.params.skuId, quantity: { gt: 0 } },
    include: { location: true, batch: true },
    orderBy: { location: { code: "asc" } },
  });
  res.json(items);
});

// Total on-hand quantity per SKU across all locations — the "live quantity"
// column on the SKU master page, and what order intake checks availability
// against while a line is being composed (see /orders/:id/stock-check for
// the per-order-line version once a draft exists).
stockRouter.get("/summary", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (_req, res) => {
  const grouped = await prisma.stockItem.groupBy({ by: ["skuId"], _sum: { quantity: true } });
  const totals = new Map(grouped.map((g) => [g.skuId, g._sum.quantity ?? 0]));
  const skus = await prisma.sku.findMany({ where: { active: true }, select: { id: true } });
  res.json(skus.map((s) => ({ skuId: s.id, totalQty: totals.get(s.id) ?? 0 })));
});

stockRouter.get("/low-stock", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (_req, res) => {
  const skus = await prisma.sku.findMany({ where: { active: true }, include: { stockItems: true } });
  const lowStock = skus
    .map((sku) => ({
      sku,
      totalQty: sku.stockItems.reduce((sum, item) => sum + item.quantity, 0),
    }))
    .filter((s) => s.totalQty <= s.sku.reorderThreshold);
  res.json(lowStock.map(({ sku, totalQty }) => ({ id: sku.id, code: sku.code, name: sku.name, reorderThreshold: sku.reorderThreshold, totalQty })));
});

stockRouter.get("/movements", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req, res) => {
  const { skuId, locationId, type, limit } = req.query;
  const movements = await prisma.stockMovement.findMany({
    where: {
      skuId: typeof skuId === "string" ? skuId : undefined,
      locationId: typeof locationId === "string" ? locationId : undefined,
      type: typeof type === "string" ? type : undefined,
    },
    include: { sku: true, location: true, batch: true, user: true },
    orderBy: { createdAt: "desc" },
    take: typeof limit === "string" ? Math.min(Number(limit) || 100, 500) : 100,
  });
  res.json(
    movements.map((m) => ({
      id: m.id,
      sku: { id: m.sku.id, code: m.sku.code, name: m.sku.name },
      location: { id: m.location.id, code: m.location.code },
      batch: m.batch ? { id: m.batch.id, batchCode: m.batch.batchCode } : null,
      quantity: m.quantity,
      type: m.type,
      reason: m.reason,
      refOrderId: m.refOrderId,
      refInvoiceRefId: m.refInvoiceRefId,
      user: { id: m.user.id, name: m.user.name },
      createdAt: m.createdAt,
    }))
  );
});

// ---- Putaway (inbound): scan-location + scan-sku, assign qty to a bin ----

const putawaySchema = z.object({
  skuId: z.string().min(1),
  locationId: z.string().min(1),
  batchId: z.string().optional(),
  quantity: z.number().int().positive(),
  reason: z.string().optional(),
});

stockRouter.post("/putaway", requireScanAccess, async (req: AuthedRequest, res) => {
  const parsed = putawaySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const { skuId, locationId, batchId, quantity, reason } = parsed.data;

  const [sku, location] = await Promise.all([
    prisma.sku.findUnique({ where: { id: skuId } }),
    prisma.location.findUnique({ where: { id: locationId } }),
  ]);
  if (!sku) return res.status(404).json({ error: "SKU not found" });
  if (!location) return res.status(404).json({ error: "Location not found" });

  const result = await prisma.$transaction((tx) =>
    applyStockMovement(tx, {
      skuId,
      locationId,
      batchId,
      quantity,
      type: "INBOUND",
      reason: reason ?? "Putaway",
      userId: req.user!.id,
    })
  );
  res.status(201).json(result);
});

// ---- Transfer between locations (rack reorganization) ----

const transferSchema = z.object({
  skuId: z.string().min(1),
  batchId: z.string().optional(),
  fromLocationId: z.string().min(1),
  toLocationId: z.string().min(1),
  quantity: z.number().int().positive(),
  reason: z.string().optional(),
});

stockRouter.post("/transfer", requireScanAccess, async (req: AuthedRequest, res) => {
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const { skuId, batchId, fromLocationId, toLocationId, quantity, reason } = parsed.data;
  if (fromLocationId === toLocationId) {
    return res.status(400).json({ error: "Source and destination locations must differ" });
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const out = await applyStockMovement(tx, {
        skuId,
        locationId: fromLocationId,
        batchId,
        quantity: -quantity,
        type: "TRANSFER_OUT",
        reason,
        userId: req.user!.id,
      });
      const inn = await applyStockMovement(tx, {
        skuId,
        locationId: toLocationId,
        batchId,
        quantity,
        type: "TRANSFER_IN",
        reason,
        relatedMovementId: out.movement.id,
        userId: req.user!.id,
      });
      await tx.stockMovement.update({ where: { id: out.movement.id }, data: { relatedMovementId: inn.movement.id } });
      return { out, inn };
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
});
