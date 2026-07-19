import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

// Order-screen consolidation: pricing (inline Unit Price editing) and
// Invoice Reference both moved from the standalone Pricing screen onto the
// order detail screen itself; that screen is now deprecated entirely. This
// widened who can reach GET /orders/:id (previously OWNER/ACCOUNTANT/SALES
// only) to also include anyone holding pricing.manageInvoiceReference or
// pricing.managePI, since those permissions now do their work inline on
// this exact screen — same class of fix as the picking access gap in
// round10.test.ts, caught proactively this time before shipping rather
// than reported after the fact.

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function blankUser() {
  const u = await createUser("SALES");
  await prisma.userPermission.deleteMany({ where: { userId: u.user.id } });
  return u;
}

// A genuine WAREHOUSE-role account with zero permissions. Deliberately
// created as WAREHOUSE from the start (not created as SALES and mutated
// afterward) — the JWT bakes `role` into its payload at sign time, so
// updating the DB row's role after the token already exists leaves the
// token itself still claiming the old role, which would silently pass any
// requireRole check regardless of the DB change. That's the trap this
// helper avoids.
async function blankWarehouseUser() {
  const u = await createUser("WAREHOUSE");
  await prisma.userPermission.deleteMany({ where: { userId: u.user.id } });
  return u;
}

async function grant(userId: string, permission: string) {
  await request(app).put(`/api/users/${userId}/permissions/${permission}`).set(auth(owner.token));
}

async function makeFinalizedOrder(buyerName: string) {
  const sku = await prisma.sku.create({ data: { code: `R11-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: "Round11 Widget", unit: "pc" } });
  const loc = await prisma.location.create({ data: { code: `R11-LOC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, zone: "Z", rack: "R" } });
  const batch = await request(app).post("/api/stock/batches").set(auth(owner.token)).send({ skuId: sku.id, sourceType: "PURCHASE", receivedQuantity: 50 });
  await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, batchId: batch.body.id, quantity: 50 });
  const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName, lines: [{ skuId: sku.id, qtyRequested: 5 }] });
  await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(owner.token));
  return { sku, order: order.body };
}

beforeAll(async () => {
  owner = await createUser("OWNER");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Order-screen consolidation — GET /orders/:id reachable by pricing permission, not just the role list", () => {
  it("a WAREHOUSE account with neither pricing permission still gets 403 on GET /orders/:id", async () => {
    const { order } = await makeFinalizedOrder("R11 Buyer 1");
    const warehouse = await createUser("WAREHOUSE");
    const res = await request(app).get(`/api/orders/${order.id}`).set(auth(warehouse.token));
    expect(res.status).toBe(403);
  });

  it("a WAREHOUSE account granted only pricing.managePI can now open the order detail page", async () => {
    const { order } = await makeFinalizedOrder("R11 Buyer 2");
    const u = await blankWarehouseUser();
    await grant(u.user.id, "pricing.managePI");

    const res = await request(app).get(`/api/orders/${order.id}`).set(auth(u.token));
    expect(res.status).toBe(200);
    // /:id/audit and /:id/stock-check are called by the same screen load —
    // both need the same broadened access or the page half-loads with a
    // stray error banner.
    const audit = await request(app).get(`/api/orders/${order.id}/audit`).set(auth(u.token));
    expect(audit.status).toBe(200);
    const stockCheck = await request(app).get(`/api/orders/${order.id}/stock-check`).set(auth(u.token));
    expect(stockCheck.status).toBe(200);
  });

  it("a WAREHOUSE account granted only pricing.manageInvoiceReference can also open it", async () => {
    const { order } = await makeFinalizedOrder("R11 Buyer 3");
    const u = await blankWarehouseUser();
    await grant(u.user.id, "pricing.manageInvoiceReference");

    const res = await request(app).get(`/api/orders/${order.id}`).set(auth(u.token));
    expect(res.status).toBe(200);
  });

  it("draft-order privacy still applies underneath the broadened gate: a non-creator without orders.viewAllDrafts still can't see someone else's draft, even with a pricing permission granted", async () => {
    const sales = await createUser("SALES");
    const sku = await prisma.sku.create({ data: { code: `R11-DRAFT-${Date.now()}`, name: "Round11 Draft Widget", unit: "pc" } });
    const draft = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "R11 Private Draft", lines: [{ skuId: sku.id, qtyRequested: 1 }] });

    const u = await blankWarehouseUser();
    await grant(u.user.id, "pricing.managePI");

    const res = await request(app).get(`/api/orders/${draft.body.id}`).set(auth(u.token));
    expect(res.status).toBe(404); // canAccessOrder's draft-privacy check runs after the route gate, unaffected by it
  });

  it("general order browsing (GET /orders) stays role-scoped, deliberately not broadened — the fix is specific to the order-detail screen the pricing/invoice-ref actions now live on", async () => {
    const u = await blankWarehouseUser();
    await grant(u.user.id, "pricing.managePI");
    const res = await request(app).get("/api/orders").set(auth(u.token));
    expect(res.status).toBe(403);
  });
});

describe("Order-screen consolidation — defaultUnitPrice on order lines, field-level protected the same as unitPrice", () => {
  it("GET /orders/:id includes defaultUnitPrice for a viewer with pricing.viewSalePrice, matching the line's actual unit", async () => {
    const sku = await prisma.sku.create({ data: { code: `R11-DEF-${Date.now()}`, name: "Round11 Default Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 } });
    await request(app).patch(`/api/skus/${sku.id}`).set(auth(owner.token)).send({ defaultPrice: 7, defaultAltUnitPrice: 65 });
    const order = await request(app).post("/api/orders").set(auth(owner.token)).send({ buyerName: "R11 Default Buyer", lines: [{ skuId: sku.id, qtyRequested: 2, unit: "Box" }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(owner.token));

    const res = await request(app).get(`/api/orders/${order.body.id}`).set(auth(owner.token));
    expect(res.body.lines[0].defaultUnitPrice).toBe(65); // alt-unit default, matching the Box unit this line finalized in
    expect(res.body.lines[0].unitPrice).toBeNull(); // nothing explicitly saved yet
  });

  it("a viewer without any pricing permission gets neither unitPrice nor defaultUnitPrice on the response — absent, not null", async () => {
    const { order, sku } = await makeFinalizedOrder("R11 Buyer 4");
    await request(app).patch(`/api/skus/${sku.id}`).set(auth(owner.token)).send({ defaultPrice: 12 });

    const blank = await blankUser();
    const res = await request(app).get(`/api/orders/${order.id}`).set(auth(blank.token));
    // orders.viewAllDrafts isn't needed here — order is FINALIZED, not a draft.
    expect(res.status).toBe(200);
    expect(res.body.lines[0]).not.toHaveProperty("unitPrice");
    expect(res.body.lines[0]).not.toHaveProperty("defaultUnitPrice");
  });

  it("a viewer with only pricing.managePI (not pricing.viewSalePrice) DOES see both fields — broadened canSeePrice", async () => {
    const { order, sku } = await makeFinalizedOrder("R11 Buyer 5");
    await request(app).patch(`/api/skus/${sku.id}`).set(auth(owner.token)).send({ defaultPrice: 12 });

    const u = await blankUser();
    await grant(u.user.id, "pricing.managePI");
    const res = await request(app).get(`/api/orders/${order.id}`).set(auth(u.token));
    expect(res.body.lines[0].defaultUnitPrice).toBe(12);
    expect(res.body.lines[0]).toHaveProperty("unitPrice");
  });
});

describe("Order-screen consolidation — inline single-line price edit and Invoice Reference creation using it", () => {
  it("PUT /orders/:id/pricing with a single line leaves other lines' prices untouched (partial update, matching the inline per-cell editor)", async () => {
    const sku1 = await prisma.sku.create({ data: { code: `R11-MULTI-1-${Date.now()}`, name: "R11 Multi Widget 1", unit: "pc" } });
    const sku2 = await prisma.sku.create({ data: { code: `R11-MULTI-2-${Date.now()}`, name: "R11 Multi Widget 2", unit: "pc" } });
    const order = await request(app)
      .post("/api/orders")
      .set(auth(owner.token))
      .send({ buyerName: "R11 Multi Buyer", lines: [{ skuId: sku1.id, qtyRequested: 1 }, { skuId: sku2.id, qtyRequested: 1 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(owner.token));

    const line1 = order.body.lines[0].id;
    const line2 = order.body.lines[1].id;
    await request(app).put(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token)).send({ lines: [{ lineId: line1, unitPrice: 10 }] });
    await request(app).put(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token)).send({ lines: [{ lineId: line2, unitPrice: 20 }] });
    // Edit line1 again — line2 must not move.
    await request(app).put(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token)).send({ lines: [{ lineId: line1, unitPrice: 15 }] });

    const res = await request(app).get(`/api/orders/${order.body.id}`).set(auth(owner.token));
    const byId = Object.fromEntries(res.body.lines.map((l: any) => [l.id, l.unitPrice]));
    expect(byId[line1]).toBe(15);
    expect(byId[line2]).toBe(20);
  });

  it("an account with only pricing.managePI (not manageInvoiceReference) cannot edit the inline price, matching the Permission Enforcement Gap fix", async () => {
    const { order } = await makeFinalizedOrder("R11 Buyer 6");
    const u = await blankUser();
    await grant(u.user.id, "pricing.managePI");
    const lineId = order.lines[0].id;
    const res = await request(app).put(`/api/orders/${order.id}/pricing`).set(auth(u.token)).send({ lines: [{ lineId, unitPrice: 30 }] });
    expect(res.status).toBe(403);
  });

  it("full flow: Accountant sets Unit Price inline, then creates an Invoice Reference using it — the invoice line's price matches what was set on the order line", async () => {
    const accountant = await createUser("ACCOUNTANT");
    const { order, sku } = await makeFinalizedOrder("R11 Buyer 7");
    const lineId = order.lines[0].id;

    const setPrice = await request(app).put(`/api/orders/${order.id}/pricing`).set(auth(accountant.token)).send({ lines: [{ lineId, unitPrice: 42 }] });
    expect(setPrice.status).toBe(200);

    const refreshed = await request(app).get(`/api/orders/${order.id}`).set(auth(accountant.token));
    const line = refreshed.body.lines[0];
    expect(line.unitPrice).toBe(42);

    const invoiceRef = await request(app)
      .post("/api/invoice-references")
      .set(auth(accountant.token))
      .send({ tallyInvoiceNumber: `R11-TALLY-${Date.now()}`, orderId: order.id, lines: [{ skuId: sku.id, qty: 5, price: line.unitPrice }] });
    expect(invoiceRef.status).toBe(201);
    expect(invoiceRef.body.lines[0].price).toBe(42);
  });
});
