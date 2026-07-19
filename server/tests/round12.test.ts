import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

// Order Lifecycle addendum: an explicit Mark Dispatched action (LOADED ->
// COMPLETED), deliberately decoupled from Invoice Reference creation, plus
// Cancel now reachable from any active state (not just DRAFT/FINALIZED)
// with put-back handling for already-picked stock and a hard block against
// cancelling out from under an active Invoice Reference.

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let sales: Awaited<ReturnType<typeof createUser>>;
let accountant: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  [owner, sales, accountant, warehouse] = await Promise.all([
    createUser("OWNER"),
    createUser("SALES"),
    createUser("ACCOUNTANT"),
    createUser("WAREHOUSE"),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

let skuCounter = 0;
async function skuWithStock(qty: number) {
  skuCounter += 1;
  const sku = await prisma.sku.create({ data: { code: `R12-SKU-${skuCounter}`, name: "Round12 Widget", unit: "pc" } });
  const loc = await prisma.location.create({ data: { code: `R12-LOC-${skuCounter}`, zone: "R12", rack: "01" } });
  await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, quantity: qty });
  return { sku, loc };
}

async function pickThrough(itemId: string, locationCode: string, skuCode: string, quantity: number) {
  await request(app).post(`/api/picking/items/${itemId}/scan-location`).set(auth(warehouse.token)).send({ locationCode });
  await request(app).post(`/api/picking/items/${itemId}/scan-sku`).set(auth(warehouse.token)).send({ label: skuCode });
  return request(app).post(`/api/picking/items/${itemId}/confirm`).set(auth(warehouse.token)).send({ quantity });
}

async function stockAt(skuId: string, locationId: string) {
  const row = await prisma.stockItem.findFirst({ where: { skuId, locationId } });
  return row?.quantity ?? 0;
}

describe("Order Lifecycle — Mark Dispatched", () => {
  it("moves a LOADED order to COMPLETED and sets completedAt, independent of any Invoice Reference", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Dispatch Buyer 1", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 5);

    const res = await request(app).post(`/api/orders/${order.body.id}/dispatch`).set(auth(sales.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(res.body.completedAt).toBeTruthy();
  });

  it("rejects dispatch from any status other than LOADED", async () => {
    const { sku } = await skuWithStock(10);
    const draft = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Dispatch Buyer 2", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const draftDispatch = await request(app).post(`/api/orders/${draft.body.id}/dispatch`).set(auth(sales.token));
    expect(draftDispatch.status).toBe(409);

    await request(app).post(`/api/orders/${draft.body.id}/finalize`).set(auth(sales.token));
    const finalizedDispatch = await request(app).post(`/api/orders/${draft.body.id}/dispatch`).set(auth(sales.token));
    expect(finalizedDispatch.status).toBe(409);
  });

  it("requires orders.editFinalized — a Warehouse account (no order permissions by default) is rejected", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Dispatch Buyer 3", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 5);

    const res = await request(app).post(`/api/orders/${order.body.id}/dispatch`).set(auth(warehouse.token));
    expect(res.status).toBe(403);
  });

  it("a COMPLETED order with no Invoice Reference is a normal state, not an error — the client derives 'invoice pending' from the (empty) invoice reference list", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Dispatch Buyer 4", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 5);
    await request(app).post(`/api/orders/${order.body.id}/dispatch`).set(auth(sales.token));

    const refs = await request(app).get(`/api/invoice-references/order/${order.body.id}`).set(auth(accountant.token));
    expect(refs.status).toBe(200);
    expect(refs.body).toEqual([]);
    const orderCheck = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(orderCheck.body.status).toBe("COMPLETED");
  });
});

describe("Order Lifecycle — Cancel from any active state", () => {
  it("cancelling a DRAFT order releases its soft reservation with no PutBackTask created", async () => {
    const { sku } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Cancel Buyer Draft", lines: [{ skuId: sku.id, qtyRequested: 5 }] });

    const res = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");

    const putBacks = await prisma.putBackTask.findMany({ where: { orderId: order.body.id } });
    expect(putBacks).toHaveLength(0);

    // The stock is no longer committed to this order — a fresh order for
    // the full quantity should succeed.
    const fresh = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Cancel Buyer Draft Retry", lines: [{ skuId: sku.id, qtyRequested: 10 }] });
    const finalize = await request(app).post(`/api/orders/${fresh.body.id}/finalize`).set(auth(sales.token));
    expect(finalize.status).toBe(200);
  });

  it("cancelling a FINALIZED (not yet picked) order releases the pick-list allocation, no PutBackTask needed", async () => {
    const { sku } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Cancel Buyer Finalized", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const res = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");

    const pickItems = await prisma.pickListItem.findMany({ where: { orderId: order.body.id } });
    expect(pickItems).toHaveLength(0);
    const putBacks = await prisma.putBackTask.findMany({ where: { orderId: order.body.id } });
    expect(putBacks).toHaveLength(0);
  });

  it("cancelling a LOADED (fully picked) order creates a PutBackTask for the picked quantity — reusing the shared reconciler, not a separate code path", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Cancel Buyer Loaded", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 5);

    const stockBefore = await stockAt(sku.id, loc.id);
    expect(stockBefore).toBe(5); // 10 - 5 picked

    const res = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");

    const putBacks = await prisma.putBackTask.findMany({ where: { orderId: order.body.id, status: "PENDING" } });
    expect(putBacks).toHaveLength(1);
    expect(putBacks[0].quantity).toBe(5);

    // Stock isn't restored until the put-back is physically confirmed —
    // it was staged/loaded, not magically back on the shelf yet.
    const stockAfterCancel = await stockAt(sku.id, loc.id);
    expect(stockAfterCancel).toBe(5);

    const confirm = await request(app).post(`/api/put-backs/${putBacks[0].id}/confirm`).set(auth(warehouse.token)).send({ locationId: loc.id });
    expect(confirm.status).toBe(200);
    const stockAfterConfirm = await stockAt(sku.id, loc.id);
    expect(stockAfterConfirm).toBe(10);
  });

  it("rejects cancelling an order with an active Invoice Reference, and reports it instead of guessing what to do", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Cancel Buyer With Invoice", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 5);
    const ref = await request(app)
      .post("/api/invoice-references")
      .set(auth(accountant.token))
      .send({ tallyInvoiceNumber: `R12-BLOCK-${Date.now()}`, orderId: order.body.id, lines: [{ skuId: sku.id, qty: 5, price: 10 }] });

    const blocked = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(blocked.status).toBe(409);
    expect(blocked.body.invoiceReferences).toEqual([expect.objectContaining({ id: ref.body.id })]);

    const stillLoaded = await request(app).get(`/api/orders/${order.body.id}`).set(auth(owner.token));
    expect(stillLoaded.body.status).toBe("LOADED");

    // Cancel the Invoice Reference first (the existing, distinct flow —
    // paperwork-only void here since these tests never dispatched), then
    // the order cancel succeeds.
    await request(app).post(`/api/invoice-references/${ref.body.id}/cancel`).set(auth(accountant.token)).send({ reverseStock: false });
    const nowCancellable = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(nowCancellable.status).toBe(200);
    expect(nowCancellable.body.status).toBe("CANCELLED");
  });

  it("rejects cancelling an already-COMPLETED or already-CANCELLED order", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Cancel Buyer Completed", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 5);
    await request(app).post(`/api/orders/${order.body.id}/dispatch`).set(auth(sales.token));

    const res = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(res.status).toBe(409);

    const cancelAgain = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(cancelAgain.status).toBe(409);
  });

  it("still requires OWNER — an Accountant cannot cancel an order", async () => {
    const { sku } = await skuWithStock(10);
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Cancel Buyer Perm", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    const res = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(accountant.token));
    expect(res.status).toBe(403);
  });
});
