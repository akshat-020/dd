import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";

export const skusRouter = Router();

skusRouter.use(requireAuth);

skusRouter.get("/", async (req, res) => {
  const activeOnly = req.query.active !== "false";
  const skus = await prisma.sku.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { name: "asc" },
  });
  res.json(skus);
});

skusRouter.get("/:id", async (req, res) => {
  const sku = await prisma.sku.findUnique({ where: { id: req.params.id } });
  if (!sku) return res.status(404).json({ error: "SKU not found" });
  res.json(sku);
});

// Both set or both omitted — an alternate unit is meaningless without its
// conversion factor and vice versa.
const altUnitFields = z
  .object({
    altUnitName: z.string().min(1).optional(),
    altUnitFactor: z.number().int().positive().optional(),
  })
  .refine((v) => (v.altUnitName == null) === (v.altUnitFactor == null), {
    message: "altUnitName and altUnitFactor must be set together",
  });

const createSkuSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    unit: z.string().min(1),
    category: z.string().optional(),
    reorderThreshold: z.number().int().min(0).default(0),
  })
  .and(altUnitFields);

skusRouter.post("/", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = createSkuSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const existing = await prisma.sku.findUnique({ where: { code: parsed.data.code } });
  if (existing) return res.status(409).json({ error: "SKU code already exists" });

  const sku = await prisma.sku.create({ data: parsed.data });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "Sku", entityId: sku.id, after: sku });
  res.status(201).json(sku);
});

// Unlike create, an update is partial by nature — a caller changing just
// altUnitFactor and leaving altUnitName untouched shouldn't have to resend
// both. Whether the two are consistent is checked below, against the
// *merged* (existing + incoming) state, not against this request in
// isolation.
const updateSkuSchema = z.object({
  name: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  category: z.string().optional(),
  reorderThreshold: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  altUnitName: z.string().min(1).optional(),
  altUnitFactor: z.number().int().positive().optional(),
  // Escape hatch for the factor-change warning below — the caller
  // re-submits with this set once the user has confirmed they understand
  // the change only applies going forward.
  confirmFactorChange: z.boolean().optional(),
});

skusRouter.patch("/:id", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = updateSkuSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.sku.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "SKU not found" });

  const { confirmFactorChange, ...data } = parsed.data;

  const mergedAltUnitName = data.altUnitName !== undefined ? data.altUnitName : before.altUnitName;
  const mergedAltUnitFactor = data.altUnitFactor !== undefined ? data.altUnitFactor : before.altUnitFactor;
  if ((mergedAltUnitName == null) !== (mergedAltUnitFactor == null)) {
    return res.status(400).json({ error: "altUnitName and altUnitFactor must be set together" });
  }

  // Changing an *existing* conversion factor (not setting one for the first
  // time) needs a warning if this SKU already has stock or open orders —
  // the new factor only applies going forward (historical OrderLine/
  // InvoiceReferenceLine rows keep the factor that was in effect when they
  // were entered), but that's easy to misread as "recalculates everything."
  const factorChanging =
    before.altUnitFactor != null && data.altUnitFactor !== undefined && data.altUnitFactor !== before.altUnitFactor;
  if (factorChanging && !confirmFactorChange) {
    const [stockCount, openOrderCount] = await Promise.all([
      prisma.stockItem.count({ where: { skuId: before.id, quantity: { gt: 0 } } }),
      prisma.orderLine.count({ where: { skuId: before.id, order: { status: { in: ["DRAFT", "FINALIZED"] } } } }),
    ]);
    if (stockCount > 0 || openOrderCount > 0) {
      return res.status(409).json({
        error: `This SKU already has stock or open orders. Changing the conversion factor only applies going forward — past stock movements and order quantities keep the old factor. Resubmit with confirmFactorChange: true to proceed.`,
        requiresConfirmation: true,
      });
    }
  }

  const sku = await prisma.sku.update({ where: { id: req.params.id }, data });
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Sku", entityId: sku.id, before, after: sku });
  res.json(sku);
});
