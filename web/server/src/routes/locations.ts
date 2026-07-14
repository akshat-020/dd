import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { generateQrPngBuffer, generateQrSvg } from "../lib/qr.js";

export const locationsRouter = Router();

locationsRouter.use(requireAuth);

// Browsing the full location list is general "inventory picture" browsing,
// so it's excluded from Warehouse's task-scoped visibility. The two lookups
// below (by id, by code) are the "standalone location-lookup search"
// exception — always available to every role, since they return a single
// location's identity (zone/rack/bin) with no quantities attached.
locationsRouter.get("/", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req, res) => {
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

// Permanently removes a location that was never really used — genuinely
// unused locations (no stock, no movement/pick-list history) can be
// deleted outright. A location with any stock currently assigned is
// always blocked (move the stock out first). A location with historical
// movement/pick-list rows but no *current* stock can't be hard-deleted
// either (those rows have a required foreign key to it) — the response
// tells the caller to deactivate it instead (PATCH active:false), which
// hides it from pickers/putaway without losing that history.
locationsRouter.delete("/:id", requireRole("OWNER", "ACCOUNTANT", "WAREHOUSE"), async (req: AuthedRequest, res) => {
  const location = await prisma.location.findUnique({ where: { id: req.params.id } });
  if (!location) return res.status(404).json({ error: "Location not found" });

  const stockHere = await prisma.stockItem.aggregate({ where: { locationId: location.id }, _sum: { quantity: true } });
  if ((stockHere._sum.quantity ?? 0) > 0) {
    return res.status(409).json({ error: "This location still has stock assigned to it — move it out before deleting." });
  }

  try {
    await prisma.location.delete({ where: { id: location.id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return res.status(409).json({
        error:
          "This location has stock movement or pick-list history and can't be permanently deleted. Deactivate it instead so it's hidden from pickers/putaway without losing that history.",
        canDeactivate: true,
      });
    }
    throw err;
  }
  await recordAudit({ userId: req.user!.id, action: "DELETE", entityType: "Location", entityId: location.id, before: location });
  res.status(204).send();
});
