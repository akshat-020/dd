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

const createSkuSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1),
  category: z.string().optional(),
  reorderThreshold: z.number().int().min(0).default(0),
});

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

const updateSkuSchema = z.object({
  name: z.string().min(1).optional(),
  unit: z.string().min(1).optional(),
  category: z.string().optional(),
  reorderThreshold: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

skusRouter.patch("/:id", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = updateSkuSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.sku.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "SKU not found" });

  const sku = await prisma.sku.update({ where: { id: req.params.id }, data: parsed.data });
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Sku", entityId: sku.id, before, after: sku });
  res.json(sku);
});
