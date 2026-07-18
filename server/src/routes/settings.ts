import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAnyPermission, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";

// Singleton company settings — bank details shown on a Proforma Invoice
// (Round-4 operational-flow addendum, item 5), and the label print layout
// (item 6: single-label vs grid/sheet, set once rather than hard-coded to
// one printer).
export const settingsRouter = Router();

settingsRouter.use(requireAuth);

async function getOrCreateSettings() {
  const existing = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
  if (existing) return existing;
  return prisma.companySettings.create({ data: { id: "singleton" } });
}

// Whoever can configure settings, or create a PI (which displays these
// bank details), can read them; only admin.configureSettings can change them.
settingsRouter.get("/", requireAnyPermission("admin.configureSettings", "pricing.managePI"), async (_req, res) => {
  res.json(await getOrCreateSettings());
});

// Label print layout isn't sensitive like bank details — anyone printing a
// label (Warehouse, scan-granted Sales) needs to know which format to render
// in, so this is open to any authenticated account rather than gated to
// Owner/Accountant like the full settings read above.
settingsRouter.get("/label-format", async (_req, res) => {
  const settings = await getOrCreateSettings();
  res.json({ labelPrintFormat: settings.labelPrintFormat });
});

const updateSchema = z.object({
  bankAccountName: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  bankIfsc: z.string().optional(),
  bankName: z.string().optional(),
  labelPrintFormat: z.enum(["SINGLE", "GRID"]).optional(),
});

settingsRouter.put("/", requirePermission("admin.configureSettings"), async (req: AuthedRequest, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const before = await getOrCreateSettings();
  const updated = await prisma.companySettings.update({
    where: { id: "singleton" },
    data: { ...parsed.data, updatedById: req.user!.id },
  });
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "CompanySettings", entityId: "singleton", before, after: updated });
  res.json(updated);
});
