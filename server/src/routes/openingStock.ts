import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { applyStockMovement } from "../lib/stock.js";
import { cellToString, cellToNumber } from "../lib/csv.js";

// Onboarding-only: declares a starting physical stock position (SKU +
// Location + quantity, in base units) as a one-time go-live baseline,
// without fabricating a fake purchase/production history to get there.
// Logged as its own StockMovement type ("OPENING_STOCK") specifically so
// it never reads as a real purchase/production inward in the ledger or
// reports — the whole point is that it's visibly a declared starting
// point, not an actual receiving event with a cost attached.
//
// Owner-only, deliberately not part of the individual-permission catalogue
// (same "structurally role-based" bucket as account management and audit
// verification, see middleware/auth.ts) — this is a foundational,
// effectively-irreversible action that shouldn't become a shortcut anyone
// with an inventory permission could reach for after go-live, when it
// would silently bypass the normal inward-entry and reconciliation flows
// this whole system exists to enforce.
export const openingStockRouter = Router();

openingStockRouter.use(requireAuth, requireRole("OWNER"));

const TEMPLATE_HEADER = ["skuCode", "locationCode", "quantity", "batchCode", "date"];

openingStockRouter.get("/template", (_req, res) => {
  const example = ["CEM-50KG", "A-01-01", "200", "", ""];
  const csv = `${TEMPLATE_HEADER.join(",")}\n${example.join(",")}\n`;
  res.type("text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="opening-stock-template.csv"');
  res.send(csv);
});

// One raw row as parsed client-side from the uploaded CSV/Excel file.
const rowSchema = z.object({
  skuCode: z.unknown().optional(),
  locationCode: z.unknown().optional(),
  quantity: z.unknown().optional(),
  // Optional lot/batch reference — if given, tags the movement with a
  // SkuBatch (sourceType OPENING_STOCK) rather than leaving it batch-less.
  batchCode: z.unknown().optional(),
  // Optional "as of" date this balance actually represents (e.g. go-live
  // day), distinct from whenever it happens to get keyed into the system.
  // Defaults to now if blank.
  date: z.unknown().optional(),
});

interface RowResult {
  rowNumber: number;
  skuCode: string | null;
  locationCode: string | null;
  quantity: number | null;
  action: "apply" | "error";
  errors: string[];
}

async function evaluateRows(rows: z.infer<typeof rowSchema>[]) {
  const skuCodes = new Set<string>();
  const locationCodes = new Set<string>();
  const parsed = rows.map((row, i) => {
    const skuCode = cellToString(row.skuCode);
    const locationCode = cellToString(row.locationCode);
    if (skuCode) skuCodes.add(skuCode);
    if (locationCode) locationCodes.add(locationCode);
    return { rowNumber: i + 1, row, skuCode, locationCode };
  });

  const [skus, locations] = await Promise.all([
    prisma.sku.findMany({ where: { code: { in: [...skuCodes] } } }),
    prisma.location.findMany({ where: { code: { in: [...locationCodes] } } }),
  ]);
  const skuByCode = new Map(skus.map((s) => [s.code, s]));
  const locationByCode = new Map(locations.map((l) => [l.code, l]));

  const results: (RowResult & { skuId?: string; locationId?: string; batchCode?: string; date?: Date })[] = [];
  for (const { rowNumber, row, skuCode, locationCode } of parsed) {
    const errors: string[] = [];

    if (!skuCode) errors.push("Missing SKU code");
    else if (!skuByCode.has(skuCode)) errors.push(`Unknown SKU code "${skuCode}"`);

    if (!locationCode) errors.push("Missing location code");
    else if (!locationByCode.has(locationCode)) errors.push(`Unknown location code "${locationCode}"`);

    const quantityRaw = cellToNumber(row.quantity);
    if (quantityRaw === undefined) errors.push("Missing quantity");
    else if (Number.isNaN(quantityRaw)) errors.push("Quantity must be a number");
    else if (!Number.isInteger(quantityRaw) || quantityRaw <= 0) errors.push("Quantity must be a positive whole number (base unit)");
    const quantity = quantityRaw !== undefined && !Number.isNaN(quantityRaw) && Number.isInteger(quantityRaw) && quantityRaw > 0 ? quantityRaw : null;

    const batchCode = cellToString(row.batchCode);

    const dateRaw = cellToString(row.date);
    let date: Date | undefined;
    if (dateRaw) {
      const parsedDate = new Date(dateRaw);
      if (Number.isNaN(parsedDate.getTime())) errors.push(`Unrecognized date "${dateRaw}"`);
      else date = parsedDate;
    }

    if (errors.length > 0) {
      results.push({ rowNumber, skuCode: skuCode ?? null, locationCode: locationCode ?? null, quantity, action: "error", errors });
      continue;
    }

    results.push({
      rowNumber,
      skuCode: skuCode!,
      locationCode: locationCode!,
      quantity,
      action: "apply",
      errors: [],
      skuId: skuByCode.get(skuCode!)!.id,
      locationId: locationByCode.get(locationCode!)!.id,
      batchCode,
      date,
    });
  }

  return results;
}

const requestSchema = z.object({ rows: z.array(rowSchema).min(1) });

openingStockRouter.post("/preview", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const results = await evaluateRows(parsed.data.rows);
  res.json({
    rows: results.map(({ skuId, locationId, batchCode, date, ...displayFields }) => displayFields),
    summary: {
      toApply: results.filter((r) => r.action === "apply").length,
      errors: results.filter((r) => r.action === "error").length,
    },
  });
});

openingStockRouter.post("/commit", async (req: AuthedRequest, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const results = await evaluateRows(parsed.data.rows);
  const applyable = results.filter((r) => r.action === "apply");

  const applied: { rowNumber: number; skuCode: string; locationCode: string; quantity: number }[] = [];
  await prisma.$transaction(async (tx) => {
    // Batch cache within this commit — two rows for the same SKU+batchCode
    // (e.g. splitting one declared lot across locations) share one
    // SkuBatch row rather than erroring on the unique constraint.
    const batchCache = new Map<string, string>(); // `${skuId}|${batchCode}` -> batchId
    for (const row of applyable) {
      let batchId: string | undefined;
      if (row.batchCode) {
        const cacheKey = `${row.skuId}|${row.batchCode}`;
        batchId = batchCache.get(cacheKey);
        if (!batchId) {
          const existing = await tx.skuBatch.findUnique({ where: { skuId_batchCode: { skuId: row.skuId!, batchCode: row.batchCode } } });
          const batch =
            existing ??
            (await tx.skuBatch.create({
              data: {
                skuId: row.skuId!,
                batchCode: row.batchCode,
                sourceType: "OPENING_STOCK",
                receivedQuantity: row.quantity!,
                receivedDate: row.date ?? new Date(),
                note: "Opening stock import",
              },
            }));
          batchId = batch.id;
          batchCache.set(cacheKey, batchId);
        }
      }

      await applyStockMovement(tx, {
        skuId: row.skuId!,
        locationId: row.locationId!,
        batchId,
        quantity: row.quantity!,
        type: "OPENING_STOCK",
        reason: "Opening stock import",
        userId: req.user!.id,
        createdAt: row.date,
      });
      applied.push({ rowNumber: row.rowNumber, skuCode: row.skuCode!, locationCode: row.locationCode!, quantity: row.quantity! });
    }
  });

  if (applied.length > 0) {
    await recordAudit({
      userId: req.user!.id,
      action: "IMPORT",
      entityType: "OpeningStock",
      entityId: randomUUID(),
      after: { rowsApplied: applied.length, rows: applied },
    });
  }

  res.json({
    applied: applied.length,
    skipped: results.length - applied.length,
    rows: results.map(({ skuId, locationId, batchCode, date, ...displayFields }) => displayFields),
  });
});
