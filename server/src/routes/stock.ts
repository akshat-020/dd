import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { hasAnyPermission } from "../lib/permissions.js";
import { encryptNumber, decryptNumber } from "../lib/crypto.js";
import { recordAudit } from "../lib/audit.js";
import { generateQrPngBuffer, generateQrSvg, encodeSkuBatchLabel } from "../lib/qr.js";
import { applyStockMovement, getCommittedQuantities, getShelvedQuantities, InsufficientStockError } from "../lib/stock.js";
import { compoundBreakdown } from "../lib/units.js";

export const stockRouter = Router();

stockRouter.use(requireAuth);

// ---- Batches (self-printed SKU labels: SKU + batch/lot + date) ----

const createBatchSchema = z.object({
  skuId: z.string().min(1),
  batchCode: z.string().min(1).optional(),
  sourceType: z.enum(["PURCHASE", "PRODUCTION"]),
  receivedQuantity: z.number().int().positive(),
  supplierRef: z.string().optional(),
  note: z.string().optional(),
});

// The "inward entry" — SKU, qty, supplier/batch ref, date. Logging this is
// what triggers SKU label printing and starts the batch on its way to being
// shelved. Deliberately separate from what it cost (PurchaseCostReference,
// below) — same physical-event/cost-event split as Order vs.
// InvoiceReference on the sales side. Auto-generates a batch code if the
// caller doesn't supply one.
stockRouter.post("/batches", requirePermission("inventory.logInwardEntry"), async (req: AuthedRequest, res) => {
  const parsed = createBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const sku = await prisma.sku.findUnique({ where: { id: parsed.data.skuId } });
  if (!sku) return res.status(404).json({ error: "SKU not found" });

  const batchCode = parsed.data.batchCode ?? `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  const batch = await prisma.skuBatch.create({
    data: {
      skuId: parsed.data.skuId,
      batchCode,
      sourceType: parsed.data.sourceType,
      receivedQuantity: parsed.data.receivedQuantity,
      supplierRef: parsed.data.supplierRef,
      note: parsed.data.note,
    },
  });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "SkuBatch", entityId: batch.id, after: batch });
  res.status(201).json(batch);
});

// Recently logged batches across all SKUs — lets someone with putaway
// access (typically Warehouse, who can't log inward entries themselves)
// find a batch that Owner/Sales already logged and shelve it, without
// needing to know which SKU to look under. Only batches that still have
// something left to shelve are offered — see getShelvedQuantities for the
// full inward -> putaway task lifecycle this is closing out.
stockRouter.get("/batches/recent", async (req: AuthedRequest, res) => {
  const allowed = await hasAnyPermission(req.user!, ["inventory.scanPutaway", "inventory.logInwardEntry"]);
  if (!allowed) return res.status(403).json({ error: "Forbidden" });

  const batches = await prisma.skuBatch.findMany({
    include: { sku: true },
    orderBy: { receivedDate: "desc" },
    take: 100,
  });
  const shelved = await getShelvedQuantities(
    prisma,
    batches.map((b) => b.id)
  );
  const withRemaining = batches
    .map((b) => ({ ...b, remainingToShelve: b.receivedQuantity == null ? null : b.receivedQuantity - (shelved.get(b.id) ?? 0) }))
    .filter((b) => b.remainingToShelve === null || b.remainingToShelve > 0)
    .slice(0, 50);
  res.json(withRemaining);
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

// ---- Purchase cost references (the financial counterpart to a batch) ----
// Owner + Accountant only, mirroring Invoice Reference on the sales side —
// floor-level receiving staff never see or enter what goods cost.

const createCostReferenceSchema = z.object({
  quantity: z.number().int().positive(),
  unitCost: z.number().nonnegative(),
  supplierRef: z.string().optional(),
  note: z.string().optional(),
});

stockRouter.post("/batches/:id/cost-references", requirePermission("pricing.logCostReference"), async (req: AuthedRequest, res) => {
  const parsed = createCostReferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const batch = await prisma.skuBatch.findUnique({ where: { id: req.params.id } });
  if (!batch) return res.status(404).json({ error: "Batch not found" });

  const ref = await prisma.purchaseCostReference.create({
    data: {
      batchId: batch.id,
      quantity: parsed.data.quantity,
      unitCost: encryptNumber(parsed.data.unitCost),
      supplierRef: parsed.data.supplierRef,
      note: parsed.data.note,
      createdById: req.user!.id,
    },
  });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "PurchaseCostReference", entityId: ref.id, after: ref });
  res.status(201).json({ ...ref, unitCost: decryptNumber(ref.unitCost) });
});

stockRouter.get("/batches/:id/cost-references", requirePermission("pricing.viewCostPrice"), async (req, res) => {
  const refs = await prisma.purchaseCostReference.findMany({
    where: { batchId: req.params.id },
    orderBy: { createdAt: "desc" },
  });
  res.json(refs.map((r) => ({ ...r, unitCost: decryptNumber(r.unitCost) })));
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

// Batch breakdown for one SKU at one specific location — deliberately
// scoped to a single (locationId, skuId) pair rather than general stock
// browsing, so it's available to Warehouse (via inventory.transferStock)
// for the transfer flow: stock is tracked per batch, so moving "whatever's
// there" isn't meaningful if more than one batch sits at that location —
// the transfer endpoint always applies to one exact batchId (or explicitly
// no batch), never "the total across batches."
stockRouter.get("/at-location/:locationId/sku/:skuId", requirePermission("inventory.transferStock"), async (req, res) => {
  const items = await prisma.stockItem.findMany({
    where: { locationId: req.params.locationId, skuId: req.params.skuId, quantity: { gt: 0 } },
    include: { batch: true },
    orderBy: { quantity: "desc" },
  });
  res.json(items.map((i) => ({ batchId: i.batchId, batchCode: i.batch?.batchCode ?? null, quantity: i.quantity })));
});

// ---- Stock queries ----

// General stock browsing is deliberately NOT available to Warehouse staff —
// their visibility is task-scoped to whatever pick list/putaway they're
// actively working (see /api/picking/* and the putaway flow), per the
// permission model. Owner/Accountant/Sales keep full, non-task-scoped access.
stockRouter.get("/", requirePermission("inventory.viewStockFull"), async (req, res) => {
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
stockRouter.get("/sku/:skuId/locations", requirePermission("inventory.viewStockFull"), async (req, res) => {
  const items = await prisma.stockItem.findMany({
    where: { skuId: req.params.skuId, quantity: { gt: 0 } },
    include: { location: true, batch: true },
    orderBy: { location: { code: "asc" } },
  });
  res.json(items);
});

// Standalone SKU -> location lookup, usable any time — not nested inside an
// active pick task, and not bundled into the SKU master page (which
// Accountant can also reach). Owner + Sales only for now: a warehouse
// staffer doing general floor work, or a sales supervisor answering "where's
// X" for someone on the phone, without needing an assigned pick list first.
stockRouter.get("/lookup/:skuId", requirePermission("inventory.viewStockFull"), async (req, res) => {
  const sku = await prisma.sku.findUnique({ where: { id: req.params.skuId } });
  if (!sku) return res.status(404).json({ error: "SKU not found" });

  const items = await prisma.stockItem.findMany({
    where: { skuId: req.params.skuId, quantity: { gt: 0 } },
    include: { location: true },
    orderBy: { location: { code: "asc" } },
  });

  // Aggregated per location (not per batch) — same reasoning as the
  // stock-on-hand report: "how much is at A-03-02" shouldn't fragment into
  // one row per batch received there.
  const byLocation = new Map<string, { locationId: string; locationCode: string; quantity: number }>();
  for (const i of items) {
    const existing = byLocation.get(i.locationId);
    if (existing) existing.quantity += i.quantity;
    else byLocation.set(i.locationId, { locationId: i.locationId, locationCode: i.location.code, quantity: i.quantity });
  }

  const totalQty = items.reduce((sum, i) => sum + i.quantity, 0);
  res.json({
    sku: { id: sku.id, code: sku.code, name: sku.name, unit: sku.unit, altUnitName: sku.altUnitName, altUnitFactor: sku.altUnitFactor },
    locations: Array.from(byLocation.values()).map((l) => ({ ...l, compound: compoundBreakdown(l.quantity, sku) })),
    totalQty,
    compound: compoundBreakdown(totalQty, sku),
  });
});

// Total on-hand quantity per SKU across all locations — the "live quantity"
// column on the SKU master page — plus `availableQty`, which is on-hand
// minus whatever's already committed to other orders (see
// getCommittedQuantities). Order intake uses `availableQty` so composing a
// new order doesn't get told stock is free when it's really already
// promised elsewhere (see /orders/:id/stock-check for the per-order-line
// version once a draft exists).
stockRouter.get("/summary", requirePermission("inventory.viewStockFull"), async (_req, res) => {
  const grouped = await prisma.stockItem.groupBy({ by: ["skuId"], _sum: { quantity: true } });
  const totals = new Map(grouped.map((g) => [g.skuId, g._sum.quantity ?? 0]));
  const skus = await prisma.sku.findMany({ where: { active: true }, select: { id: true } });
  const committed = await getCommittedQuantities(prisma, skus.map((s) => s.id));
  res.json(
    skus.map((s) => {
      const totalQty = totals.get(s.id) ?? 0;
      const committedQty = committed.get(s.id) ?? 0;
      return { skuId: s.id, totalQty, committedQty, availableQty: Math.max(totalQty - committedQty, 0) };
    })
  );
});

stockRouter.get("/low-stock", requirePermission("inventory.viewStockFull"), async (_req, res) => {
  const skus = await prisma.sku.findMany({ where: { active: true }, include: { stockItems: true } });
  const lowStock = skus
    .map((sku) => ({
      sku,
      totalQty: sku.stockItems.reduce((sum, item) => sum + item.quantity, 0),
    }))
    .filter((s) => s.totalQty <= s.sku.reorderThreshold);
  res.json(lowStock.map(({ sku, totalQty }) => ({ id: sku.id, code: sku.code, name: sku.name, reorderThreshold: sku.reorderThreshold, totalQty })));
});

stockRouter.get("/movements", requirePermission("inventory.viewStockFull"), async (req, res) => {
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

stockRouter.post("/putaway", requirePermission("inventory.scanPutaway"), async (req: AuthedRequest, res) => {
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

  // Same "remaining to shelve" definition as /batches/recent — closes the
  // task and stops over-shelving past what was actually received.
  if (batchId) {
    const batch = await prisma.skuBatch.findUnique({ where: { id: batchId } });
    if (!batch) return res.status(404).json({ error: "Batch not found" });
    if (batch.receivedQuantity != null) {
      const shelved = await getShelvedQuantities(prisma, [batchId]);
      const remaining = batch.receivedQuantity - (shelved.get(batchId) ?? 0);
      if (quantity > remaining) {
        return res.status(409).json({ error: `Cannot shelve more than the ${Math.max(remaining, 0)} remaining for this batch` });
      }
    }
  }

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

stockRouter.post("/transfer", requirePermission("inventory.transferStock"), async (req: AuthedRequest, res) => {
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
