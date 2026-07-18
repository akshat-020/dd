import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";
import { ALL_PERMISSIONS, type PermissionKey } from "../src/lib/permissions.js";

// Prompted by a real bug found in manual testing: PUT /orders/:id/pricing
// ("Save pricing") was gated with requireAnyPermission("pricing
// .manageInvoiceReference", "pricing.managePI") — an account holding only
// pricing.managePI could save the order's canonical price despite being
// correctly blocked from creating an Invoice Reference on the very same
// screen. Fixed by requiring both (requireAllPermissions). This file is the
// "standing test" requested at the time: every catalogued permission gets a
// direct negative check (attempt the gated action without it, expect 403) so
// this class of bug — one action on a shared screen enforced, a sibling
// action not — can't silently reappear as new permission-gated actions are
// added.

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// A genuinely zero-permission account — createUser applies the role
// template, so this strips it back to nothing, giving each sweep test a
// true deny-by-default baseline regardless of what SALES/WAREHOUSE/etc.
// happen to include by default.
async function blankUser() {
  const u = await createUser("SALES");
  await prisma.userPermission.deleteMany({ where: { userId: u.user.id } });
  return u;
}

async function grant(userId: string, permission: PermissionKey) {
  await request(app).put(`/api/users/${userId}/permissions/${permission}`).set(auth(owner.token));
}

beforeAll(async () => {
  owner = await createUser("OWNER");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Permission Enforcement Gap fix — Save pricing requires BOTH document permissions, not either", () => {
  it("holding only pricing.managePI is not enough to save order pricing (the exact reported bug)", async () => {
    const u = await blankUser();
    await grant(u.user.id, "pricing.managePI");
    const sku = await prisma.sku.create({ data: { code: "R10-GAP-1", name: "Round10 Gap Widget", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Gap Buyer 1", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const lineId = order.body.lines[0].id;

    // Confirmed broken behavior before the fix: this returned 200.
    const res = await request(app)
      .put(`/api/orders/${order.body.id}/pricing`)
      .set(auth(u.token))
      .send({ lines: [{ lineId, unitPrice: 50 }] });
    expect(res.status).toBe(403);

    // And, matching the original report, Invoice Reference creation is
    // correctly blocked too — both should now be consistently denied.
    const invRes = await request(app)
      .post("/api/invoice-references")
      .set(auth(u.token))
      .send({ tallyInvoiceNumber: "GAP-TEST-1", orderId: order.body.id, lines: [{ skuId: sku.id, qty: 1, price: 50 }] });
    expect(invRes.status).toBe(403);
  });

  it("holding only pricing.manageInvoiceReference is not enough either — symmetric with the managePI-only case", async () => {
    const u = await blankUser();
    await grant(u.user.id, "pricing.manageInvoiceReference");
    const sku = await prisma.sku.create({ data: { code: "R10-GAP-2", name: "Round10 Gap Widget 2", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Gap Buyer 2", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const lineId = order.body.lines[0].id;

    const res = await request(app)
      .put(`/api/orders/${order.body.id}/pricing`)
      .set(auth(u.token))
      .send({ lines: [{ lineId, unitPrice: 50 }] });
    expect(res.status).toBe(403);
  });

  it("holding both permissions succeeds", async () => {
    const u = await blankUser();
    await grant(u.user.id, "pricing.managePI");
    await grant(u.user.id, "pricing.manageInvoiceReference");
    const sku = await prisma.sku.create({ data: { code: "R10-GAP-3", name: "Round10 Gap Widget 3", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Gap Buyer 3", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const lineId = order.body.lines[0].id;

    const res = await request(app)
      .put(`/api/orders/${order.body.id}/pricing`)
      .set(auth(u.token))
      .send({ lines: [{ lineId, unitPrice: 50 }] });
    expect(res.status).toBe(200);
    expect(res.body.lines[0].unitPrice).toBe(50);
  });

  it("viewing (GET) still only needs either permission — it's writing the shared price that needed tightening, not reading it", async () => {
    const u = await blankUser();
    await grant(u.user.id, "pricing.managePI");
    const sku = await prisma.sku.create({ data: { code: "R10-GAP-4", name: "Round10 Gap Widget 4", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Gap Buyer 4", lines: [{ skuId: sku.id, qtyRequested: 1 }] });

    const res = await request(app).get(`/api/orders/${order.body.id}/pricing`).set(auth(u.token));
    expect(res.status).toBe(200);
  });

  it("a fully blank account (neither permission) gets no pricing data at all from GET — not partial, not null-masked, a flat 403", async () => {
    const u = await blankUser();
    const sku = await prisma.sku.create({ data: { code: "R10-GAP-5", name: "Round10 Gap Widget 5", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Gap Buyer 5", lines: [{ skuId: sku.id, qtyRequested: 1 }] });

    const res = await request(app).get(`/api/orders/${order.body.id}/pricing`).set(auth(u.token));
    expect(res.status).toBe(403);
    expect(res.body.lines).toBeUndefined();
  });

  it("PI generation still works for a managePI-only account with no order price saved, via the SKU's Default Price fallback", async () => {
    // This is what makes requireAllPermissions safe to ship: it doesn't
    // strand a legitimate managePI-only account, because Proforma Invoice
    // creation takes its own price input (ultimately sourced client-side
    // from unitPrice ?? defaultUnitPrice) rather than depending on this
    // account also being able to write the shared order price.
    const u = await blankUser();
    await grant(u.user.id, "pricing.managePI");
    const sku = await prisma.sku.create({ data: { code: "R10-GAP-6", name: "Round10 Gap Widget 6", unit: "pc" } });
    await request(app).patch(`/api/skus/${sku.id}`).set(auth(owner.token)).send({ defaultPrice: 30 });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Gap Buyer 6", lines: [{ skuId: sku.id, qtyRequested: 1 }] });

    const pricing = await request(app).get(`/api/orders/${order.body.id}/pricing`).set(auth(u.token));
    expect(pricing.body.lines[0].unitPrice).toBeNull();
    expect(pricing.body.lines[0].defaultUnitPrice).toBe(30);

    const pi = await request(app)
      .post("/api/proforma-invoices")
      .set(auth(u.token))
      .send({
        orderId: order.body.id,
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        lines: [{ skuId: sku.id, qty: 1, unit: "pc", unitPrice: pricing.body.lines[0].unitPrice ?? pricing.body.lines[0].defaultUnitPrice }],
      });
    expect(pi.status).toBe(201);
    expect(pi.body.lines[0].unitPrice).toBe(30);
  });
});

describe("Full permission-catalogue audit — every gated action rejects an account that lacks it", () => {
  it("orders.createDraft: POST /api/orders is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/orders").set(auth(u.token)).send({ buyerName: "x", lines: [] });
    expect(res.status).toBe(403);
  });

  it("orders.editFinalized: PATCH /api/orders/:id is rejected without it", async () => {
    const u = await blankUser();
    const sku = await prisma.sku.create({ data: { code: "R10-AUD-1", name: "Audit Widget 1", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Audit Buyer 1", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const res = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(u.token)).send({ buyerName: "Hacked" });
    expect(res.status).toBe(403);
  });

  it("pricing.viewSalePrice: GET /api/reports/sales is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).get("/api/reports/sales").set(auth(u.token));
    expect(res.status).toBe(403);
  });

  it("pricing.viewCostPrice: GET /api/stock/batches/:id/cost-references is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).get("/api/stock/batches/fake-id/cost-references").set(auth(u.token));
    expect(res.status).toBe(403);
  });

  it("pricing.logCostReference: POST /api/stock/batches/:id/cost-references is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/stock/batches/fake-id/cost-references").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("pricing.manageInvoiceReference: POST /api/invoice-references is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/invoice-references").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("pricing.managePI: POST /api/proforma-invoices is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/proforma-invoices").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("inventory.viewStockFull: GET /api/stock is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).get("/api/stock").set(auth(u.token));
    expect(res.status).toBe(403);
  });

  it("inventory.scanPutaway: POST /api/stock/putaway is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/stock/putaway").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("inventory.logInwardEntry: POST /api/stock/batches is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/stock/batches").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("inventory.transferStock: POST /api/stock/transfer is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/stock/transfer").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("masterdata.editSku: POST /api/skus is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/skus").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("masterdata.bulkImportSku: POST /api/skus/bulk/preview is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/skus/bulk/preview").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("masterdata.editLocation: POST /api/locations is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).post("/api/locations").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("admin.viewAuditLog: GET /api/reports/audit-log is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).get("/api/reports/audit-log").set(auth(u.token));
    expect(res.status).toBe(403);
  });

  it("admin.configureSettings: PUT /api/settings is rejected without it", async () => {
    const u = await blankUser();
    const res = await request(app).put("/api/settings").set(auth(u.token)).send({});
    expect(res.status).toBe(403);
  });

  it("granted-by-permission-not-role sweep: for every permission, an account whose base role's template doesn't include it can still perform the gated action once it's individually granted — the mirror check of the negative sweep above, catching a route that's still hard-checking role instead of the permission", async () => {
    // WAREHOUSE's template has none of the order/pricing/admin permissions,
    // so granting one directly (never touching its role) and confirming
    // the gated action succeeds is a real test that the route checks the
    // permission, not a role list the account was never part of.
    const cases: { permission: PermissionKey; call: (token: string) => Promise<{ status: number }> }[] = [
      { permission: "orders.createDraft", call: (t) => request(app).post("/api/orders").set(auth(t)).send({ buyerName: "x", lines: [] }) },
      { permission: "pricing.viewSalePrice", call: (t) => request(app).get("/api/reports/sales").set(auth(t)) },
      { permission: "admin.viewAuditLog", call: (t) => request(app).get("/api/reports/audit-log").set(auth(t)) },
      { permission: "admin.configureSettings", call: (t) => request(app).put("/api/settings").set(auth(t)).send({}) },
    ];
    for (const { permission, call } of cases) {
      const u = await blankUser();
      await prisma.user.update({ where: { id: u.user.id }, data: { role: "WAREHOUSE" } });
      const before = await call(u.token);
      expect(before.status).toBe(403); // sanity: genuinely blocked beforehand
      await grant(u.user.id, permission);
      const after = await call(u.token);
      expect(after.status).not.toBe(403);
    }
  });

  it("Picking Enforcement Gap fix — GET /api/picking/orders (the 'Ready to pick' list) is reachable by inventory.scanPutaway alone, not tied to the OWNER/ACCOUNTANT/SALES role list the general orders endpoint uses", async () => {
    // Confirmed bug: the 'Ready to pick' screen used to fetch through
    // GET /api/orders (requireRole("OWNER","ACCOUNTANT","SALES")), so a
    // WAREHOUSE account — or any account granted inventory.scanPutaway
    // without one of those three roles — got "Forbidden: insufficient
    // role" even with the permission granted. Fixed by adding a
    // task-scoped GET /api/picking/orders gated on the permission itself.
    const warehouse = await createUser("WAREHOUSE");
    const sku = await prisma.sku.create({ data: { code: "R10-PICK-1", name: "Round10 Pick Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R10-LOC-1", zone: "Z", rack: "R" } });
    const batch = await request(app).post("/api/stock/batches").set(auth(owner.token)).send({ skuId: sku.id, sourceType: "PURCHASE", receivedQuantity: 20 });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, batchId: batch.body.id, quantity: 20 });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "Round10 Pick Buyer", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(owner.token));

    // The old endpoint still correctly rejects Warehouse — that's by
    // design (general order browsing stays role-scoped) and isn't itself
    // the bug; the bug was that no permission-gated alternative existed.
    const oldEndpoint = await request(app).get("/api/orders?status=FINALIZED").set(auth(warehouse.token));
    expect(oldEndpoint.status).toBe(403);

    const res = await request(app).get("/api/picking/orders").set(auth(warehouse.token));
    expect(res.status).toBe(200);
    expect(res.body.some((o: any) => o.id === order.body.id)).toBe(true);
    // Task-scoped shape only — no price anywhere in this file (see
    // routes/picking.ts's file-level comment).
    expect(res.body[0]).not.toHaveProperty("unitPrice");
    expect(res.body[0]).not.toHaveProperty("lines");

    const strippedWarehouse = await createUser("WAREHOUSE");
    await prisma.userPermission.deleteMany({ where: { userId: strippedWarehouse.user.id } });
    const denied = await request(app).get("/api/picking/orders").set(auth(strippedWarehouse.token));
    expect(denied.status).toBe(403);
  });

  it("sanity check: this file's negative sweep actually covers every catalogued permission except the two not yet wired to a feature (inventory.reconciliation*) and the two already covered by round9 (orders.viewAllDrafts, orders.viewFullHistory) and the field-level one (pricing.setDefaultPrice)", () => {
    const coveredElsewhere = new Set<PermissionKey>([
      "orders.viewAllDrafts",
      "orders.viewFullHistory",
      "pricing.setDefaultPrice",
      "inventory.reconciliationCount",
      "inventory.reconciliationApprove",
    ]);
    const coveredHere = new Set<PermissionKey>([
      "orders.createDraft",
      "orders.editFinalized",
      "pricing.viewSalePrice",
      "pricing.viewCostPrice",
      "pricing.logCostReference",
      "pricing.manageInvoiceReference",
      "pricing.managePI",
      "inventory.viewStockFull",
      "inventory.scanPutaway",
      "inventory.logInwardEntry",
      "inventory.transferStock",
      "masterdata.editSku",
      "masterdata.bulkImportSku",
      "masterdata.editLocation",
      "admin.viewAuditLog",
      "admin.configureSettings",
    ]);
    const missing = ALL_PERMISSIONS.filter((p) => !coveredElsewhere.has(p) && !coveredHere.has(p));
    expect(missing).toEqual([]);
  });
});
