import { Router, type NextFunction, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, requirePermission, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { hasPermission, hasAnyPermission } from "../lib/permissions.js";
import type { Role } from "../lib/roles.js";
import { decryptNumber } from "../lib/crypto.js";
import { skuDefaultPriceForUnit } from "../lib/pricing.js";
import { getCommittedQuantities, reconcileOrderLineAllocation, ShortfallError } from "../lib/stock.js";
import { resolveUnitFactor, toBaseQty, InvalidUnitError } from "../lib/units.js";

export const ordersRouter = Router();

ordersRouter.use(requireAuth);

// Broadened beyond just pricing.viewSalePrice: an account holding either of
// the two financial-document permissions needs to see price on an order
// it's working with too, even without the general "view sale price"
// permission — same reasoning as the OR-gated GET /:id/pricing endpoint.
function canSeePrice(user: { id: string; role: Role }) {
  return hasAnyPermission(user, ["pricing.viewSalePrice", "pricing.manageInvoiceReference", "pricing.managePI"]);
}

// General order browsing (GET /) stays deliberately scoped to
// OWNER/ACCOUNTANT/SALES — it was never part of the permission catalogue,
// see that route's own comment. But the order *detail* view (this order,
// specifically) is also where pricing/Invoice Reference/Proforma Invoice
// now live inline (see the order-screen consolidation), so an account
// holding either of those two permissions needs to reach a specific
// order's detail page even from a base role outside that list — the same
// class of gap already fixed for the picking screen (a permission grant
// that a role-list gate couldn't honor).
function requireOrderViewAccess() {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (["OWNER", "ACCOUNTANT", "SALES"].includes(req.user.role)) return next();
    if (await hasAnyPermission(req.user, ["pricing.manageInvoiceReference", "pricing.managePI"])) return next();
    return res.status(403).json({ error: "Forbidden: insufficient role" });
  };
}

// A DRAFT order is a not-yet-committed conversation with a buyer — visible
// only to whoever created it (plus Owner, consistent with Owner's
// unrestricted access everywhere else). Once finalized it's no longer a
// private draft, so every other role's existing access resumes as before.
async function canAccessOrder(user: { id: string; role: Role }, order: { status: string; createdById: string }) {
  if (order.status !== "DRAFT") return true;
  if (order.createdById === user.id) return true;
  return hasPermission(user, "orders.viewAllDrafts");
}

// Role-safe one-line summary for an audit entry — never mentions price,
// regardless of what the entry's before/after blob actually contains (an
// Owner/Accountant's edit can capture price data in `after`; a Sales
// viewer must never see that raw blob at all, only this summary). Full
// before/after detail is attached separately by the /:id/audit handler,
// only for roles that can already see pricing.
function describeAuditEntry(entry: { action: string; entityType: string; after: string | null }): string {
  const after = entry.after ? JSON.parse(entry.after) : null;
  switch (`${entry.entityType}:${entry.action}`) {
    case "Order:CREATE":
      return "Order created";
    case "Order:UPDATE":
      return "Order edited";
    case "Order:FINALIZE":
      return "Order finalized — pick list generated";
    case "Order:DISPATCH":
      return "Order dispatched";
    case "Order:CANCEL":
      return "Order cancelled";
    case "Order:SET_PRICING":
      return "Pricing updated";
    case "PickListItem:PICK_CONFIRM":
      return after?.boxesOpened > 0 ? "Item picked (box opened to fulfill quantity)" : "Item picked";
    case "PickListItem:PICK_SHORTFALL":
      return `Partial pick — shortfall of ${after?.shortfall ?? "?"} follow-up created`;
    case "InvoiceReference:CREATE":
      return "Invoice reference logged";
    case "InvoiceReference:CANCEL":
      return "Invoice reference cancelled";
    case "InvoiceReference:ADJUST":
      return "Invoice reference adjusted";
    case "PutBackTask:PUT_BACK_CONFIRM":
      return "Put-back confirmed — stock returned to shelf";
    case "ProformaInvoice:CREATE":
      return "Proforma Invoice generated";
    case "ProformaInvoice:REISSUE":
      return "Proforma Invoice reissued";
    default:
      return `${entry.action} — ${entry.entityType}`;
  }
}

async function serializeOrder(orderId: string, includePrice: boolean) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      createdBy: { select: { id: true, name: true } },
      lines: {
        include: {
          sku: true,
          ...(includePrice ? { price: true } : {}),
        },
      },
    },
  });
  if (!order) return null;

  // Quantity currently "in limbo" per line — physically picked, no longer
  // needed at the reduced Final Qty, but not yet physically confirmed back
  // on a shelf (see reconcileOrderLineAllocation's PutBackTask creation).
  // Surfaced here rather than left implicit in qtyPicked vs qtyFinalized so
  // the UI has one clear signal for "this line has a pending return."
  const pendingPutBacks = await prisma.putBackTask.groupBy({
    by: ["orderLineId"],
    where: { orderId, status: "PENDING" },
    _sum: { quantity: true },
  });
  const pendingByLine = new Map(pendingPutBacks.map((p) => [p.orderLineId, p._sum.quantity ?? 0]));

  return {
    ...order,
    lines: order.lines.map((line: any) => {
      const { price, ...rest } = line;
      const withPending = { ...rest, pendingPutBackQty: pendingByLine.get(line.id) ?? 0 };
      if (!includePrice) return withPending;
      const unit = line.finalUnit ?? line.requestedUnit ?? null;
      return {
        ...withPending,
        unitPrice: price ? decryptNumber(price.unitPrice) : null,
        // Prefill hint for the order screen's inline price editor — same
        // rule as GET /:id/pricing, kept in sync via the shared helper.
        defaultUnitPrice: skuDefaultPriceForUnit(line.sku, unit),
      };
    }),
  };
}

// General order browsing is excluded from Warehouse's task-scoped
// visibility — their view is entirely /api/picking/* (which never touches
// this router), plus /api/reports/my-task-history for their own completed
// work. See the permission model addendum.
ordersRouter.get("/", requireRole("OWNER", "ACCOUNTANT", "SALES"), async (req: AuthedRequest, res) => {
  const { status, search, from, to } = req.query;
  const user = req.user!;
  const { id: userId } = user;

  const statusFilter = typeof status === "string" && status ? status : undefined;
  const searchTerm = typeof search === "string" && search.trim() ? search.trim() : undefined;
  const fromDate = typeof from === "string" && from ? new Date(from) : undefined;
  const toDate = typeof to === "string" && to ? new Date(to) : undefined;

  // Draft orders are scoped to their creator (+ whoever can view all
  // drafts) at the query level, not filtered out afterward — see
  // canAccessOrder above. AND-ing this in with every other filter (rather
  // than branching on each combination) also naturally handles "explicitly
  // filtering to DRAFT without that permission" correctly: {status: DRAFT}
  // AND ({status != DRAFT} OR {own}) reduces to {status: DRAFT, own} on
  // its own.
  const canViewAllDrafts = await hasPermission(user, "orders.viewAllDrafts");
  const roleScope: Record<string, unknown> = canViewAllDrafts ? {} : { OR: [{ status: { not: "DRAFT" } }, { createdById: userId }] };

  const filters: Record<string, unknown>[] = [roleScope];
  if (statusFilter) filters.push({ status: statusFilter });
  if (fromDate) filters.push({ createdAt: { gte: fromDate } });
  if (toDate) filters.push({ createdAt: { lte: toDate } });
  if (searchTerm) {
    filters.push({
      OR: [
        { orderNumber: { contains: searchTerm, mode: "insensitive" } },
        { buyerName: { contains: searchTerm, mode: "insensitive" } },
        {
          lines: {
            some: {
              sku: { OR: [{ code: { contains: searchTerm, mode: "insensitive" } }, { name: { contains: searchTerm, mode: "insensitive" } }] },
            },
          },
        },
      ],
    });
  }

  // Default view (no explicit filter): recent orders (last 3 days) plus
  // anything still active regardless of age — an old order still awaiting
  // dispatch shouldn't disappear just because it's older than the recency
  // window. Whoever lacks "view full order history" is held to this window
  // as a hard ceiling even WITH an explicit filter — a search/date-range
  // narrows within what's visible, it doesn't unlock reaching further back.
  const hasExplicitFilter = !!statusFilter || !!searchTerm || !!fromDate || !!toDate;
  const canViewFullHistory = await hasPermission(user, "orders.viewFullHistory");
  if (!hasExplicitFilter || !canViewFullHistory) {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    filters.push({ OR: [{ createdAt: { gte: threeDaysAgo } }, { status: { notIn: ["LOADED", "COMPLETED", "CANCELLED"] } }] });
  }

  const orders = await prisma.order.findMany({
    where: { AND: filters },
    include: { createdBy: { select: { id: true, name: true } }, lines: { include: { sku: true } } },
    orderBy: { createdAt: "desc" },
  });
  const includePrice = await canSeePrice(user);
  const serialized = includePrice
    ? await Promise.all(orders.map((o) => serializeOrder(o.id, true)))
    : orders.map((o) => ({ ...o, lines: o.lines.map(({ ...l }) => l) }));
  res.json(serialized);
});

ordersRouter.get("/:id", requireOrderViewAccess(), async (req: AuthedRequest, res) => {
  const raw = await prisma.order.findUnique({ where: { id: req.params.id }, select: { status: true, createdById: true } });
  if (!raw || !(await canAccessOrder(req.user!, raw))) return res.status(404).json({ error: "Order not found" });
  const order = await serializeOrder(req.params.id, await canSeePrice(req.user!));
  res.json(order);
});

// Per-order Activity/History — who created it, who picked each line (and
// whether it was full/partial/a box-break), who logged the Invoice
// Reference, and any edits, all in one chronological view instead of
// raw logs buried in the backend. The underlying audit trail already
// exists (see lib/audit.ts) — this just queries and formats it per order,
// no new instrumentation. Sales gets a role-safe summary of each event
// (e.g. "Invoice reference logged") with no price data attached; Owner/
// Accountant additionally get the full before/after detail.
ordersRouter.get("/:id/audit", requireOrderViewAccess(), async (req: AuthedRequest, res) => {
  const raw = await prisma.order.findUnique({ where: { id: req.params.id }, select: { status: true, createdById: true } });
  if (!raw || !(await canAccessOrder(req.user!, raw))) return res.status(404).json({ error: "Order not found" });

  const orderId = req.params.id;
  const [pickItems, invoiceRefs, putBackTasks, proformaInvoices] = await Promise.all([
    prisma.pickListItem.findMany({ where: { orderId }, select: { id: true } }),
    prisma.invoiceReference.findMany({ where: { orderId }, select: { id: true } }),
    prisma.putBackTask.findMany({ where: { orderId }, select: { id: true } }),
    prisma.proformaInvoice.findMany({ where: { orderId }, select: { id: true } }),
  ]);

  const entries = await prisma.auditLog.findMany({
    where: {
      OR: [
        { entityType: "Order", entityId: orderId },
        { entityType: "PickListItem", entityId: { in: pickItems.map((i) => i.id) } },
        { entityType: "InvoiceReference", entityId: { in: invoiceRefs.map((i) => i.id) } },
        { entityType: "PutBackTask", entityId: { in: putBackTasks.map((i) => i.id) } },
        { entityType: "ProformaInvoice", entityId: { in: proformaInvoices.map((i) => i.id) } },
      ],
    },
    include: { user: { select: { id: true, name: true, role: true } } },
    orderBy: { createdAt: "asc" },
  });

  const showDetail = await canSeePrice(req.user!);
  res.json(
    entries.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      createdAt: e.createdAt,
      user: e.user,
      summary: describeAuditEntry(e),
      ...(showDetail ? { before: e.before ? JSON.parse(e.before) : null, after: e.after ? JSON.parse(e.after) : null } : {}),
    }))
  );
});

const orderLineInput = z.object({
  skuId: z.string().min(1),
  // In `unit` if provided, else the SKU's base unit — see resolveUnitFactor.
  qtyRequested: z.number().int().positive(),
  unit: z.string().optional(),
  notes: z.string().optional(),
});

const createOrderSchema = z.object({
  buyerName: z.string().min(1),
  buyerContact: z.string().optional(),
  vehicleCapacityNote: z.string().optional(),
  lines: z.array(orderLineInput).min(1),
});

ordersRouter.post("/", requirePermission("orders.createDraft"), async (req: AuthedRequest, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }

  const skus = await prisma.sku.findMany({ where: { id: { in: parsed.data.lines.map((l) => l.skuId) } } });
  const skuById = new Map(skus.map((s) => [s.id, s]));
  const missing = parsed.data.lines.find((l) => !skuById.has(l.skuId));
  if (missing) return res.status(404).json({ error: `SKU ${missing.skuId} not found` });

  let lineData;
  try {
    lineData = parsed.data.lines.map((l) => {
      const { unit, factor } = resolveUnitFactor(skuById.get(l.skuId)!, l.unit);
      return {
        skuId: l.skuId,
        qtyRequested: toBaseQty(l.qtyRequested, factor),
        requestedUnit: unit,
        requestedUnitQty: l.qtyRequested,
        requestedFactor: factor,
        notes: l.notes,
      };
    });
  } catch (err) {
    if (err instanceof InvalidUnitError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const orderNumber = `ORD-${Date.now().toString(36).toUpperCase()}`;
  const order = await prisma.order.create({
    data: {
      orderNumber,
      buyerName: parsed.data.buyerName,
      buyerContact: parsed.data.buyerContact,
      vehicleCapacityNote: parsed.data.vehicleCapacityNote,
      createdById: req.user!.id,
      lines: { create: lineData },
    },
    include: { lines: { include: { sku: true } } },
  });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "Order", entityId: order.id, after: order });
  res.status(201).json(order);
});

// Live stock availability check for every line on a draft order. `available`
// is on-hand stock minus whatever's already committed to *other* orders
// (other open drafts' requested qty, other finalized-but-not-yet-picked
// orders' pick-list qty) — checking against raw on-hand alone lets two
// orders both get told a SKU is available when there's really only enough
// for one (see getCommittedQuantities in lib/stock.ts).
ordersRouter.get("/:id/stock-check", requireOrderViewAccess(), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: { include: { sku: true } } } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (!(await canAccessOrder(req.user!, order))) return res.status(404).json({ error: "Order not found" });

  const skuIds = order.lines.map((l) => l.skuId);
  const [stockAgg, committed] = await Promise.all([
    prisma.stockItem.groupBy({ by: ["skuId"], where: { skuId: { in: skuIds } }, _sum: { quantity: true } }),
    getCommittedQuantities(prisma, skuIds, order.id),
  ]);
  const onHandBySku = new Map(stockAgg.map((g) => [g.skuId, g._sum.quantity ?? 0]));

  const results = order.lines.map((line) => {
    const onHand = onHandBySku.get(line.skuId) ?? 0;
    const committedElsewhere = committed.get(line.skuId) ?? 0;
    const available = Math.max(onHand - committedElsewhere, 0);
    const requested = line.qtyFinalized ?? line.qtyRequested;
    return {
      lineId: line.id,
      skuId: line.skuId,
      skuCode: line.sku.code,
      skuName: line.sku.name,
      requested,
      available,
      committedElsewhere,
      sufficient: available >= requested,
    };
  });
  res.json(results);
});

const updateLinesSchema = z.object({
  buyerName: z.string().min(1).optional(),
  buyerContact: z.string().optional(),
  vehicleCapacityNote: z.string().optional(),
  lines: z
    .array(
      z.object({
        id: z.string().optional(), // omit to add a new line
        skuId: z.string().min(1).optional(),
        qtyRequested: z.number().int().positive().optional(), // only used when adding a new line — see below
        qtyFinalized: z.number().int().min(0).optional(),
        // Applies to whichever of qtyRequested/qtyFinalized is present in
        // this line — in that unit if provided, else the SKU's base unit.
        unit: z.string().optional(),
        notes: z.string().optional(),
        remove: z.boolean().optional(),
      })
    )
    .optional(),
});

// Edit an order. Requested qty is the original ask and is locked the
// moment a line exists — this endpoint only ever writes qtyRequested when
// *creating* a new line (no `id`); an existing line's `qtyRequested` in the
// payload is ignored. Final Qty (qtyFinalized) is the one editable
// quantity field, and it's what actually drives stock allocation.
//
// Editable while DRAFT (no PickListItems exist yet, so this is a plain
// field update), FINALIZED, or LOADED (up to the point it's actually
// dispatched — COMPLETED/CANCELLED are locked). LOADED is deliberately
// still editable, not locked the moment picking completes: the
// operational-flow addendum's post-pick adjustment scenario is exactly
// "picked, not yet dispatched" — i.e. LOADED — and reducing a line there
// has to be allowed so the put-back path (reconcileOrderLineAllocation)
// can trigger. Editing a FINALIZED or LOADED order's quantities reconciles
// the pick list allocation immediately, so nothing about location
// assignments (or, for a reduction below what's picked, the resulting
// put-back task) goes stale; once an order is actually dispatched
// (COMPLETED) it's locked — physically gone, nothing left to reconcile.
ordersRouter.patch("/:id", requirePermission("orders.editFinalized"), async (req: AuthedRequest, res) => {
  const parsed = updateLinesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!before || !(await canAccessOrder(req.user!, before))) return res.status(404).json({ error: "Order not found" });
  if (before.status !== "DRAFT" && before.status !== "FINALIZED" && before.status !== "LOADED") {
    return res.status(409).json({ error: "Only draft, finalized, or loaded (not yet invoiced) orders can be edited" });
  }
  const isFinalized = before.status === "FINALIZED" || before.status === "LOADED";

  try {
    await prisma.$transaction(async (tx) => {
      const { lines, ...orderFields } = parsed.data;
      if (Object.keys(orderFields).length > 0) {
        await tx.order.update({ where: { id: before.id }, data: orderFields });
      }
      for (const line of lines ?? []) {
        if (line.id && line.remove) {
          const existing = before.lines.find((l) => l.id === line.id);
          if (!existing) continue;
          if (isFinalized) {
            if (existing.qtyPicked > 0) {
              throw new Error(`Cannot remove ${existing.skuId} — it's already been partially or fully picked`);
            }
            await tx.pickListItem.deleteMany({ where: { orderLineId: existing.id, status: { not: "PICKED" } } });
          }
          await tx.orderLine.delete({ where: { id: line.id } });
        } else if (line.id) {
          const existing = before.lines.find((l) => l.id === line.id);
          if (!existing) continue;
          const data: Record<string, unknown> = { notes: line.notes };
          if (line.qtyFinalized !== undefined) {
            const sku = await tx.sku.findUnique({ where: { id: existing.skuId } });
            if (!sku) throw new Error(`SKU ${existing.skuId} not found`);
            const { unit, factor } = resolveUnitFactor(sku, line.unit);
            const baseQty = toBaseQty(line.qtyFinalized, factor);
            data.qtyFinalized = baseQty;
            data.finalUnit = unit;
            data.finalUnitQty = line.qtyFinalized;
            data.finalFactor = factor;
            if (isFinalized) {
              await reconcileOrderLineAllocation(tx, { orderId: before.id, orderLineId: existing.id, skuId: existing.skuId, newQty: baseQty });
            }
          }
          await tx.orderLine.update({ where: { id: line.id }, data });
        } else if (line.skuId && line.qtyRequested) {
          const sku = await tx.sku.findUnique({ where: { id: line.skuId } });
          if (!sku) throw new Error(`SKU ${line.skuId} not found`);
          const { unit, factor } = resolveUnitFactor(sku, line.unit);
          const baseQty = toBaseQty(line.qtyRequested, factor);
          const newLine = await tx.orderLine.create({
            data: {
              orderId: before.id,
              skuId: line.skuId,
              qtyRequested: baseQty,
              requestedUnit: unit,
              requestedUnitQty: line.qtyRequested,
              requestedFactor: factor,
              qtyFinalized: isFinalized ? baseQty : undefined,
              finalUnit: isFinalized ? unit : undefined,
              finalUnitQty: isFinalized ? line.qtyRequested : undefined,
              finalFactor: isFinalized ? factor : undefined,
              notes: line.notes,
            },
          });
          if (isFinalized) {
            await reconcileOrderLineAllocation(tx, { orderId: before.id, orderLineId: newLine.id, skuId: newLine.skuId, newQty: baseQty });
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof ShortfallError) {
      return res.status(409).json({ error: err.message, skuId: err.skuId, requested: err.requested, available: err.available });
    }
    if (err instanceof Error) {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }

  const after = await serializeOrder(before.id, await canSeePrice(req.user!));
  await recordAudit({ userId: req.user!.id, action: "UPDATE", entityType: "Order", entityId: before.id, before, after });
  res.json(after);
});

// Finalize: locks in quantities, then allocates each line to specific stock
// locations (largest bin first, to minimize pick stops) and generates a
// pick list grouped/sequenced by location for the loading team.
ordersRouter.post("/:id/finalize", requirePermission("orders.createDraft"), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!order || !(await canAccessOrder(req.user!, order))) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "DRAFT") {
    return res.status(409).json({ error: "Only draft orders can be finalized" });
  }

  const result = await prisma.$transaction(async (tx) => {
    // Same commitment accounting as the stock-check endpoint — without this,
    // two orders finalizing around the same time could each see the full
    // physical on-hand quantity and both succeed, oversubscribing the same
    // stock (finalize only *allocates* to specific bins; the actual
    // StockItem deduction doesn't happen until the physical pick-confirm
    // scan, so on-hand alone isn't the truth at this point).
    const committed = await getCommittedQuantities(
      tx,
      order.lines.map((l) => l.skuId),
      order.id
    );
    const onHandBySku = new Map(
      (
        await tx.stockItem.groupBy({ by: ["skuId"], where: { skuId: { in: order.lines.map((l) => l.skuId) } }, _sum: { quantity: true } })
      ).map((g) => [g.skuId, g._sum.quantity ?? 0])
    );

    // Phase 1: a dry run across every line, checking sufficiency *before*
    // writing anything — this is what lets a shortfall on line 3 still
    // report shortfalls on lines 1 and 2 in the same response, instead of
    // aborting after the first one found. Two lines requesting the same
    // SKU compete for the same on-hand total, so their demand has to
    // accumulate across this pass (claimedThisRun) — checking each line
    // against the raw on-hand figure independently would let both "pass"
    // even when there isn't enough for both combined.
    const shortfalls: { skuId: string; requested: number; available: number }[] = [];
    const claimedThisRun = new Map<string, number>();
    for (const line of order.lines) {
      const qty = line.qtyFinalized ?? line.qtyRequested;
      if (qty === 0) continue;
      const totalOnHand = onHandBySku.get(line.skuId) ?? 0;
      const committedElsewhere = committed.get(line.skuId) ?? 0;
      const claimedSoFar = claimedThisRun.get(line.skuId) ?? 0;
      const trulyAvailable = totalOnHand - committedElsewhere - claimedSoFar;
      if (trulyAvailable < qty) {
        shortfalls.push({ skuId: line.skuId, requested: qty, available: Math.max(trulyAvailable, 0) });
      } else {
        claimedThisRun.set(line.skuId, claimedSoFar + qty);
      }
    }
    if (shortfalls.length > 0) {
      return { shortfalls };
    }

    // Phase 2: sufficiency is guaranteed, so actually allocate — one line
    // at a time, via the same per-line reconciler PATCH /orders/:id uses,
    // so a fresh finalize and a later Final-Qty edit share one allocation
    // path instead of two subtly different implementations. Because each
    // call commits its PickListItem rows within this same transaction, a
    // later line sharing a SKU with an earlier one correctly sees (and
    // doesn't re-claim) what that earlier line already took.
    for (const line of order.lines) {
      const qty = line.qtyFinalized ?? line.qtyRequested;
      // Carry the requested unit/factor over as the final unit/factor when
      // Final Qty hasn't been separately edited (the common case) — display
      // should keep showing "5 Box", not silently drop to base-unit pcs.
      const finalUnitFields =
        line.finalUnitQty != null
          ? {}
          : { finalUnit: line.requestedUnit, finalUnitQty: line.requestedUnitQty, finalFactor: line.requestedFactor };
      await tx.orderLine.update({ where: { id: line.id }, data: { qtyFinalized: qty, ...finalUnitFields } });
      if (qty === 0) continue;
      await reconcileOrderLineAllocation(tx, { orderId: order.id, orderLineId: line.id, skuId: line.skuId, newQty: qty });
    }

    // Re-sequence by location code so the loading team follows one route
    // through the warehouse instead of zig-zagging — allocating per line
    // (above) means rows land in whatever order each line's own greedy
    // allocation produced them, not grouped by location across the order.
    const created = await tx.pickListItem.findMany({ where: { orderId: order.id }, include: { location: true }, orderBy: { sequence: "asc" } });
    const sorted = [...created].sort((a, b) => a.location.code.localeCompare(b.location.code));
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].sequence !== i + 1) {
        await tx.pickListItem.update({ where: { id: sorted[i].id }, data: { sequence: i + 1 } });
      }
    }

    await tx.order.update({ where: { id: order.id }, data: { status: "FINALIZED", finalizedAt: new Date() } });
    return { shortfalls: [] as { skuId: string; requested: number; available: number }[] };
  });

  if (result.shortfalls.length > 0) {
    return res.status(409).json({ error: "Insufficient stock to finalize", shortfalls: result.shortfalls });
  }

  await recordAudit({ userId: req.user!.id, action: "FINALIZE", entityType: "Order", entityId: order.id, after: { status: "FINALIZED" } });
  const after = await serializeOrder(order.id, await canSeePrice(req.user!));
  res.json(after);
});

// Mark Dispatched: the explicit action that closes out a LOADED order —
// deliberately not tied to Invoice Reference creation, since invoicing
// often lags behind physical dispatch in practice (see the order-lifecycle
// addendum). A COMPLETED order with no active Invoice Reference yet is a
// perfectly normal, expected in-between state ("Completed — invoice
// pending"), not an error condition — the client renders that from
// invoiceReferences, nothing server-side needs to track it separately.
ordersRouter.post("/:id/dispatch", requirePermission("orders.editFinalized"), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order || !(await canAccessOrder(req.user!, order))) return res.status(404).json({ error: "Order not found" });
  if (order.status !== "LOADED") {
    return res.status(409).json({ error: "Only a loaded order can be marked dispatched" });
  }
  const updated = await prisma.order.update({ where: { id: order.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  await recordAudit({ userId: req.user!.id, action: "DISPATCH", entityType: "Order", entityId: order.id, before: order, after: updated });
  const after = await serializeOrder(order.id, await canSeePrice(req.user!));
  res.json(after);
});

ordersRouter.post("/:id/cancel", requireRole("OWNER"), async (req: AuthedRequest, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { lines: true } });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status === "COMPLETED" || order.status === "CANCELLED") {
    return res.status(409).json({ error: `Cannot cancel an order that is already ${order.status.toLowerCase()}` });
  }

  // A cancelled order must never leave a dangling active Invoice Reference
  // pointing at it — that would break the reconciliation trail the whole
  // system is built around. Block rather than silently cancel the
  // reference too: whether goods were actually returned is a distinct,
  // consequential decision that belongs to the existing Cancel Invoice
  // Reference flow (routes/invoiceReferences.ts), not an assumption made
  // as a side effect here.
  const activeInvoiceRefs = await prisma.invoiceReference.findMany({
    where: { orderId: order.id, status: { not: "CANCELLED" } },
    select: { id: true, tallyInvoiceNumber: true },
  });
  if (activeInvoiceRefs.length > 0) {
    return res.status(409).json({
      error: "Cannot cancel an order with an active Invoice Reference — cancel the Invoice Reference first.",
      invoiceReferences: activeInvoiceRefs,
    });
  }

  await prisma.$transaction(async (tx) => {
    // Same shared reconciler finalize and PATCH /orders/:id both already
    // use — dropping every line to zero releases any not-yet-picked
    // allocation and queues a PutBackTask per already-picked/loaded
    // quantity, so cancellation needs no separate stock-adjustment code
    // path (the exact class of bug already fixed once for per-line
    // allocation isn't worth risking a second implementation of). For a
    // DRAFT order this is a no-op — there's nothing to reconcile since no
    // PickListItems exist yet; the reservation itself is just the soft
    // getCommittedQuantities count on a DRAFT order, which disappears the
    // moment status flips away from DRAFT below.
    for (const line of order.lines) {
      await reconcileOrderLineAllocation(tx, { orderId: order.id, orderLineId: line.id, skuId: line.skuId, newQty: 0 });
    }
    await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
  });

  const updated = await prisma.order.findUnique({ where: { id: order.id } });
  await recordAudit({ userId: req.user!.id, action: "CANCEL", entityType: "Order", entityId: order.id, before: order, after: updated });
  res.json(updated);
});
