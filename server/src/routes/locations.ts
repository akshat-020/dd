import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { generateQrPngBuffer, generateQrSvg } from "../lib/qr.js";

export const locationsRouter = Router();

locationsRouter.use(requireAuth);

locationsRouter.get("/", async (req, res) => {
  const activeOnly = req.query.active !== "false";
  const locations = await prisma.location.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: [{ zone: "asc" }, { rack: "asc" }, { bin: "asc" }],
  });
  res.json(locations);
});

locationsRouter.get("/:id", async (req, res) => {
  const location = await prisma.location.findUnique({ where: { id: req.params.id } });
  if (!location) return res.status(404).json({ error: "Location not found" });
  res.json(location);
});

// Location code is what's encoded in the QR label (e.g. "A-03-02"). Lookup
// by code is what the picking/putaway scan flow uses.
locationsRouter.get("/by-code/:code", async (req, res) => {
  const location = await prisma.location.findUnique({ where: { code: req.params.code } });
  if (!location) return res.status(404).json({ error: "Location not found" });
  res.json(location);
});

locationsRouter.get("/:id/qr", async (req, res) => {
  const location = await prisma.location.findUnique({ where: { id: req.params.id } });
  if (!location) return res.status(404).json({ error: "Location not found" });

  if (req.query.format === "svg") {
    const svg = await generateQrSvg(location.code);
    res.type("image/svg+xml").send(svg);
    return;
  }
  const png = await generateQrPngBuffer(location.code);
  res.type("image/png").send(png);
});

const createLocationSchema = z.object({
  code: z.string().min(1),
  zone: z.string().min(1),
  rack: z.string().min(1),
  bin: z.string().optional(),
});

locationsRouter.post("/", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = createLocationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const existing = await prisma.location.findUnique({ where: { code: parsed.data.code } });
  if (existing) return res.status(409).json({ error: "Location code already exists" });

  const location = await prisma.location.create({ data: parsed.data });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "Location", entityId: location.id, after: location });
  res.status(201).json(location);
});

const bulkImportSchema = z.object({
  locations: z.array(createLocationSchema).min(1),
});

// Bulk-load the spreadsheet of location codes produced during the physical
// labeling walkthrough (see brief section 10, step 2).
locationsRouter.post("/bulk-import", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = bulkImportSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }

  const created: string[] = [];
  const skipped: string[] = [];
  for (const loc of parsed.data.locations) {
    const existing = await prisma.location.findUnique({ where: { code: loc.code } });
    if (existing) {
      skipped.push(loc.code);
      continue;
    }
    const location = await prisma.location.create({ data: loc });
    created.push(location.code);
  }
  await recordAudit({
    userId: req.user!.id,
    action: "BULK_IMPORT",
    entityType: "Location",
    entityId: "bulk",
    after: { created, skipped },
  });
  res.status(201).json({ created, skipped });
});

const updateLocationSchema = z.object({
  zone: z.string().min(1).optional(),
  rack: z.string().min(1).optional(),
  bin: z.string().optional(),
  active: z.boolean().optional(),
});

locationsRouter.patch("/:id", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const parsed = updateLocationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.location.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "Location not found" });

  const location = await prisma.location.update({ where: { id: req.params.id }, data: parsed.data });
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Location", entityId: location.id, before, after: location });
  res.json(location);
});
