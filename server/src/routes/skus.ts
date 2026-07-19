import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { hasAnyPermission, hasPermission } from "../lib/permissions.js";
import { encryptNumber, decryptNumber } from "../lib/crypto.js";
import { cellToString, cellToNumber } from "../lib/csv.js";
import type { Role } from "../lib/roles.js";

export const skusRouter = Router();

skusRouter.use(requireAuth);

// Default Price (MRP) is protected independently of the rest of the SKU
// record — someone editing a SKU's name/category doesn't necessarily have
// pricing access, so the field must not appear in the API response at all
// for them, not just be greyed out client-side. Anyone who can already see
// sale price elsewhere, or who can set the default themselves, can see it.
function canSeeDefaultPrice(user: { id: string; role: Role }) {
  return hasAnyPermission(user, ["pricing.viewSalePrice", "pricing.setDefaultPrice"]);
}

async function serializeSku<T extends { defaultPrice: string | null; defaultAltUnitPrice: string | null }>(
  sku: T,
  user: { id: string; role: Role }
) {
  const { defaultPrice, defaultAltUnitPrice, ...rest } = sku;
  if (!(await canSeeDefaultPrice(user))) return rest;
  return {
    ...rest,
    defaultPrice: defaultPrice ? decryptNumber(defaultPrice) : null,
    defaultAltUnitPrice: defaultAltUnitPrice ? decryptNumber(defaultAltUnitPrice) : null,
  };
}

skusRouter.get("/", async (req: AuthedRequest, res) => {
  const activeOnly = req.query.active !== "false";
  const skus = await prisma.sku.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { name: "asc" },
  });
  res.json(await Promise.all(skus.map((s) => serializeSku(s, req.user!))));
});

skusRouter.get("/:id", async (req: AuthedRequest, res) => {
  const sku = await prisma.sku.findUnique({ where: { id: req.params.id } });
  if (!sku) return res.status(404).json({ error: "SKU not found" });
  res.json(await serializeSku(sku, req.user!));
});

// ---- Bulk import (add + update in one pass, matched by SKU code) ----
// Same access tier as the single-record edit (create/update above) — no
// new permission introduced for the bulk path.

const BULK_TEMPLATE_HEADER = ["code", "name", "category", "unit", "altUnitName", "altUnitFactor", "reorderThreshold"];

skusRouter.get("/bulk/template", requirePermission("masterdata.bulkImportSku"), (_req, res) => {
  const example = ["CEM-50KG", "Cement 50kg Bag", "Cement", "bag", "Box", "10", "50"];
  const csv = `${BULK_TEMPLATE_HEADER.join(",")}\n${example.join(",")}\n`;
  res.type("text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="sku-bulk-import-template.csv"');
  res.send(csv);
});

// One raw row as parsed client-side from the uploaded CSV/Excel file —
// every cell arrives as whatever the sheet parser produced (string, number,
// or blank/undefined), so everything here is read defensively rather than
// assumed to already be the right type.
const bulkRowSchema = z.object({
  code: z.unknown().optional(),
  name: z.unknown().optional(),
  category: z.unknown().optional(),
  unit: z.unknown().optional(),
  altUnitName: z.unknown().optional(),
  altUnitFactor: z.unknown().optional(),
  reorderThreshold: z.unknown().optional(),
  // Per-row escape hatch for the factor-change safety check, set by the
  // client once the user has confirmed a specific row's warning — mirrors
  // confirmFactorChange on the single-record PATCH above, just per-row
  // instead of per-request since one file can contain many such rows.
  confirmFactorChange: z.boolean().optional(),
});

const bulkRequestSchema = z.object({ rows: z.array(bulkRowSchema).min(1) });

interface BulkRowResult {
  rowNumber: number; // 1-based, matching the data rows below the header
  code: string | null;
  action: "create" | "update" | "error";
  errors: string[];
  changes?: Record<string, { from: unknown; to: unknown }>;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
  // Populated only when action can proceed — the exact Prisma payload this
  // row would apply, computed once here and reused as-is by commit so
  // preview and commit can never disagree about what a row means.
  createData?: Record<string, unknown>;
  updateData?: Record<string, unknown>;
  skuId?: string;
}

async function evaluateBulkRows(rows: z.infer<typeof bulkRowSchema>[]): Promise<BulkRowResult[]> {
  const codeOccurrences = new Map<string, number[]>(); // code -> row numbers sharing it
  const parsedRows = rows.map((row, i) => {
    const rowNumber = i + 1;
    const code = cellToString(row.code);
    if (code) {
      const list = codeOccurrences.get(code) ?? [];
      list.push(rowNumber);
      codeOccurrences.set(code, list);
    }
    return { rowNumber, row, code };
  });

  const codes = [...codeOccurrences.keys()];
  const existing = await prisma.sku.findMany({ where: { code: { in: codes } } });
  const existingByCode = new Map(existing.map((s) => [s.code, s]));

  const results: BulkRowResult[] = [];
  for (const { rowNumber, row, code } of parsedRows) {
    const errors: string[] = [];

    if (!code) errors.push("Missing SKU code");
    else if ((codeOccurrences.get(code)?.length ?? 0) > 1) errors.push("Duplicate SKU code within file");

    const name = cellToString(row.name);
    if (!name) errors.push("Missing SKU name");

    const unit = cellToString(row.unit);
    if (!unit) errors.push("Missing base unit");

    const category = cellToString(row.category);

    const altUnitName = cellToString(row.altUnitName);
    const altUnitFactorRaw = cellToNumber(row.altUnitFactor);
    if (Number.isNaN(altUnitFactorRaw)) errors.push("Conversion factor must be a number");
    const altUnitFactor = Number.isNaN(altUnitFactorRaw) ? undefined : altUnitFactorRaw;
    if (altUnitFactor !== undefined && (!Number.isInteger(altUnitFactor) || altUnitFactor <= 0)) {
      errors.push("Conversion factor must be a positive whole number");
    }
    if ((altUnitName != null) !== (altUnitFactor != null && !Number.isNaN(altUnitFactorRaw))) {
      errors.push("Alternate unit and conversion factor must be set together");
    }

    const reorderThresholdRaw = cellToNumber(row.reorderThreshold);
    if (Number.isNaN(reorderThresholdRaw)) errors.push("Reorder threshold must be a number");
    const reorderThreshold = Number.isNaN(reorderThresholdRaw) ? undefined : reorderThresholdRaw;
    if (reorderThreshold !== undefined && (!Number.isInteger(reorderThreshold) || reorderThreshold < 0)) {
      errors.push("Reorder threshold must be a whole number, zero or more");
    }

    if (errors.length > 0) {
      results.push({ rowNumber, code: code ?? null, action: "error", errors });
      continue;
    }

    const existingSku = existingByCode.get(code!);

    if (!existingSku) {
      results.push({
        rowNumber,
        code: code!,
        action: "create",
        errors: [],
        createData: {
          code: code!,
          name: name!,
          unit: unit!,
          category: category ?? null,
          altUnitName: altUnitName ?? null,
          altUnitFactor: altUnitFactor ?? null,
          reorderThreshold: reorderThreshold ?? 0,
        },
      });
      continue;
    }

    // Blank optional cells on an update row mean "leave as-is" — a
    // spreadsheet re-upload that only fills in what changed shouldn't wipe
    // out everything it left blank. Required columns (name/unit) are still
    // mandatory on every row (already enforced above) so there's no
    // ambiguity there.
    const updateData: Record<string, unknown> = { name: name!, unit: unit! };
    if (category !== undefined) updateData.category = category;
    if (altUnitName !== undefined || altUnitFactor !== undefined) {
      updateData.altUnitName = altUnitName ?? null;
      updateData.altUnitFactor = altUnitFactor ?? null;
    }
    if (reorderThreshold !== undefined) updateData.reorderThreshold = reorderThreshold;

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [field, value] of Object.entries(updateData)) {
      const before = (existingSku as Record<string, unknown>)[field];
      if (before !== value) changes[field] = { from: before, to: value };
    }

    const factorChanging =
      existingSku.altUnitFactor != null && "altUnitFactor" in updateData && updateData.altUnitFactor !== existingSku.altUnitFactor;

    if (factorChanging && !row.confirmFactorChange) {
      const [stockCount, openOrderCount] = await Promise.all([
        prisma.stockItem.count({ where: { skuId: existingSku.id, quantity: { gt: 0 } } }),
        prisma.orderLine.count({ where: { skuId: existingSku.id, order: { status: { in: ["DRAFT", "FINALIZED"] } } } }),
      ]);
      if (stockCount > 0 || openOrderCount > 0) {
        results.push({
          rowNumber,
          code: code!,
          action: "update",
          errors: [],
          changes,
          skuId: existingSku.id,
          updateData,
          requiresConfirmation: true,
          confirmationMessage:
            "This SKU already has stock or open orders. Changing the conversion factor only applies going forward — past stock movements and order quantities keep the old factor.",
        });
        continue;
      }
    }

    if (Object.keys(changes).length === 0) {
      results.push({ rowNumber, code: code!, action: "update", errors: [], changes, skuId: existingSku.id });
      continue;
    }

    results.push({ rowNumber, code: code!, action: "update", errors: [], changes, skuId: existingSku.id, updateData });
  }

  return results;
}

skusRouter.post("/bulk/preview", requirePermission("masterdata.bulkImportSku"), async (req, res) => {
  const parsed = bulkRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const results = await evaluateBulkRows(parsed.data.rows);
  res.json({
    rows: results.map(({ createData, updateData, skuId, ...rest }) => rest),
    summary: {
      toCreate: results.filter((r) => r.action === "create").length,
      toUpdate: results.filter((r) => r.action === "update" && !r.requiresConfirmation).length,
      needsConfirmation: results.filter((r) => r.requiresConfirmation).length,
      errors: results.filter((r) => r.action === "error").length,
    },
  });
});

skusRouter.post("/bulk/commit", requirePermission("masterdata.bulkImportSku"), async (req: AuthedRequest, res) => {
  const parsed = bulkRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  // Re-derived fresh here rather than trusting whatever the client last saw
  // from /preview — state (another user's edit, stock arriving, an order
  // opening) may have moved on since the preview was shown.
  const results = await evaluateBulkRows(parsed.data.rows);

  let created = 0;
  let updated = 0;
  const outcomes: (Omit<BulkRowResult, "createData" | "updateData" | "skuId"> & {
    status: "created" | "updated" | "unchanged" | "skipped";
  })[] = [];

  for (const r of results) {
    if (r.action === "error" || r.requiresConfirmation) {
      outcomes.push({ ...r, status: "skipped" });
      continue;
    }
    if (r.action === "create" && r.createData) {
      const sku = await prisma.sku.create({ data: r.createData as Prisma.SkuCreateInput });
      await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "Sku", entityId: sku.id, after: sku });
      created += 1;
      outcomes.push({ rowNumber: r.rowNumber, code: r.code, action: r.action, errors: [], status: "created" });
      continue;
    }
    if (r.action === "update" && r.skuId) {
      if (r.updateData) {
        const before = await prisma.sku.findUnique({ where: { id: r.skuId } });
        const sku = await prisma.sku.update({ where: { id: r.skuId }, data: r.updateData as Prisma.SkuUpdateInput });
        await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Sku", entityId: sku.id, before, after: sku });
        updated += 1;
        outcomes.push({ rowNumber: r.rowNumber, code: r.code, action: r.action, errors: [], changes: r.changes, status: "updated" });
      } else {
        // No actual changes for this row (file matched what's already
        // there) — not an error, just nothing to do, and not counted as
        // either created or updated.
        outcomes.push({ rowNumber: r.rowNumber, code: r.code, action: r.action, errors: [], changes: r.changes, status: "unchanged" });
      }
      continue;
    }
    outcomes.push({ ...r, status: "skipped" });
  }

  res.json({ created, updated, skipped: outcomes.filter((o) => o.status === "skipped").length, rows: outcomes });
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

// Default Price (MRP) — optional per-unit prefill values, independently
// gated by pricing.setDefaultPrice (see serializeSku above). A caller
// without that permission can still create/edit a SKU normally; these two
// fields are just silently dropped from their request rather than
// rejecting the whole thing — matching "must not appear for them at all,"
// not "editing a SKU requires pricing access."
const defaultPriceFields = z.object({
  defaultPrice: z.number().nonnegative().optional(),
  defaultAltUnitPrice: z.number().nonnegative().optional(),
});

const createSkuSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().min(1),
    unit: z.string().min(1),
    category: z.string().optional(),
    reorderThreshold: z.number().int().min(0).default(0),
  })
  .and(altUnitFields)
  .and(defaultPriceFields);

skusRouter.post("/", requirePermission("masterdata.editSku"), async (req: AuthedRequest, res) => {
  const parsed = createSkuSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const existing = await prisma.sku.findUnique({ where: { code: parsed.data.code } });
  if (existing) return res.status(409).json({ error: "SKU code already exists" });

  const { defaultPrice, defaultAltUnitPrice, ...rest } = parsed.data;
  const canSetPrice = await hasPermission(req.user!, "pricing.setDefaultPrice");
  const data: Prisma.SkuCreateInput = {
    ...rest,
    ...(canSetPrice && defaultPrice !== undefined ? { defaultPrice: encryptNumber(defaultPrice) } : {}),
    ...(canSetPrice && defaultAltUnitPrice !== undefined ? { defaultAltUnitPrice: encryptNumber(defaultAltUnitPrice) } : {}),
  };

  const sku = await prisma.sku.create({ data });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "Sku", entityId: sku.id, after: sku });
  res.status(201).json(await serializeSku(sku, req.user!));
});

// Unlike create, an update is partial by nature — a caller changing just
// altUnitFactor and leaving altUnitName untouched shouldn't have to resend
// both. Whether the two are consistent is checked below, against the
// *merged* (existing + incoming) state, not against this request in
// isolation.
const updateSkuSchema = z
  .object({
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
  })
  .and(defaultPriceFields);

skusRouter.patch("/:id", requirePermission("masterdata.editSku"), async (req: AuthedRequest, res) => {
  const parsed = updateSkuSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.sku.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "SKU not found" });

  const { confirmFactorChange, defaultPrice, defaultAltUnitPrice, ...data } = parsed.data;
  const canSetPrice = await hasPermission(req.user!, "pricing.setDefaultPrice");
  if (canSetPrice && defaultPrice !== undefined) (data as Record<string, unknown>).defaultPrice = encryptNumber(defaultPrice);
  if (canSetPrice && defaultAltUnitPrice !== undefined) (data as Record<string, unknown>).defaultAltUnitPrice = encryptNumber(defaultAltUnitPrice);

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
  res.json(await serializeSku(sku, req.user!));
});
