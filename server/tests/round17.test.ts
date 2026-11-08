import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

// Bug fix (second instance of the same class as round16): Invoice Reference
// cancellation (reverseStock) and adjustment run as a separate stock-
// reversal mechanism from reconcileOrderLineAllocation's put-back tasks, and
// independently drew on a PICKED item's raw qtyPicked without checking
// whether some of it was already queued for return via a pending (not yet
// physically confirmed) PutBackTask — e.g. from a Final Qty reduction made
// while the order was still LOADED, before the Invoice Reference was
// cancelled/adjusted. That could double-credit stock once the pending
// put-back was later confirmed too. See lib/stock.ts's pendingPutBackByItem,
// now shared by reconcileOrderLineAllocation and routes/invoiceReferences.ts.

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

async function pickThrough(itemId: string, locationCode: string, skuCode: string, quantity: number) {
  await request(app).post(`/api/picking/items/${itemId}/scan-location`).set(auth(warehouse.token)).send({ locationCode });
  await request(app).post(`/api/picking/items/${itemId}/scan-sku`).set(auth(warehouse.token)).send({ label: skuCode });
  return request(app).post(`/api/picking/items/${itemId}/confirm`).set(auth(warehouse.token)).send({ quantity });
}

async function stockAt(skuId: string, locationId: string) {
  const row = await prisma.stockItem.findFirst({ where: { skuId, locationId } });
  return row?.quantity ?? 0;
}

// Shared setup: one SKU/location, a line picked in full (qty 10), an Invoice
// Reference logged for the full qty while the order is still LOADED (not
// yet dispatched — Invoice References can be added at that point), then a
// Final Qty reduction down to 4 that queues a PENDING (unconfirmed)
// PutBackTask for 6 against the single picked item.
async function setupWithPendingPutBack(skuCodeSuffix: string) {
  const sku = await prisma.sku.create({ data: { code: `R17-SKU-${skuCodeSuffix}`, name: "Round17 Widget", unit: "pc" } });
  const loc = await prisma.location.create({ data: { code: `R17-LOC-${skuCodeSuffix}`, zone: "R17", rack: "01" } });
  await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 10 });

  const order = await request(app)
    .post("/api/orders")
    .set(auth(sales.token))
    .send({ buyerName: `Round17 Buyer ${skuCodeSuffix}`, lines: [{ skuId: sku.id, qtyRequested: 10 }] });
  const lineId = order.body.lines[0].id;
  await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

  const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
  const item = pickList.body[0];
  await pickThrough(item.id, loc.code, sku.code, 10);

  const ref = await request(app)
    .post("/api/invoice-references")
    .set(auth(accountant.token))
    .send({ tallyInvoiceNumber: `R17-INV-${skuCodeSuffix}-${Date.now()}`, orderId: order.body.id, lines: [{ skuId: sku.id, qty: 10, price: 100 }] });
  expect(ref.status).toBe(201);

  // Reduce Final Qty 10 -> 4 while the invoice reference is already active
  // and the order is still LOADED (editable) — queues a PENDING put-back of
  // 6 against the one picked item, unconfirmed.
  const reduce = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ id: lineId, qtyFinalized: 4 }] });
  expect(reduce.status).toBe(200);

  const pending = await prisma.putBackTask.findMany({ where: { orderId: order.body.id, status: "PENDING" } });
  expect(pending).toHaveLength(1);
  expect(pending[0].quantity).toBe(6);

  return { sku, loc, order, refId: ref.body.id, lineId: ref.body.lines[0].id, pendingTask: pending[0] };
}

describe("Invoice Reference cancel (reverseStock) — no double-counting against a pending put-back", () => {
  it("only restores what's genuinely still outstanding, net of the already-pending put-back", async () => {
    const { sku, loc, order, refId, pendingTask } = await setupWithPendingPutBack("cancel");

    const before = await stockAt(sku.id, loc.id);
    const cancelled = await request(app).post(`/api/invoice-references/${refId}/cancel`).set(auth(accountant.token)).send({ reverseStock: true });
    expect(cancelled.status).toBe(200);
    const after = await stockAt(sku.id, loc.id);

    // Billed qty was 10, but 6 of the item's 10 qtyPicked is already queued
    // for return via the pending put-back — reversing the invoice should
    // only credit back the remaining 4, not the full 10.
    expect(after - before).toBe(4);

    // The pending put-back itself is untouched by the invoice cancellation.
    const stillPending = await prisma.putBackTask.findUnique({ where: { id: pendingTask.id } });
    expect(stillPending?.status).toBe("PENDING");
    expect(stillPending?.quantity).toBe(6);

    // Confirming it afterward brings total restored stock to exactly the
    // original 10 picked — never more.
    const confirm = await request(app).post(`/api/put-backs/${pendingTask.id}/confirm`).set(auth(warehouse.token));
    expect(confirm.status).toBe(200);
    expect(await stockAt(sku.id, loc.id)).toBe(before + 10);

    const orderFinal = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(orderFinal.body.status).toBe("LOADED");
  });
});

describe("Invoice Reference adjust — no double-counting against a pending put-back", () => {
  it("caps the restored stock at what's still genuinely outstanding on the picked item", async () => {
    const { sku, loc, refId, lineId, pendingTask } = await setupWithPendingPutBack("adjust");

    const before = await stockAt(sku.id, loc.id);
    // Adjust the billed qty 10 -> 4 (qtyDelta = 6, "6 units returned") —
    // but only 4 of the item's qtyPicked is actually still unclaimed by any
    // pending put-back, so only 4 should be restored here.
    const adjust = await request(app).post(`/api/invoice-references/${refId}/adjust`).set(auth(accountant.token)).send({ lines: [{ invoiceLineId: lineId, qty: 4 }] });
    expect(adjust.status).toBe(200);
    const after = await stockAt(sku.id, loc.id);
    expect(after - before).toBe(4);

    const stillPending = await prisma.putBackTask.findUnique({ where: { id: pendingTask.id } });
    expect(stillPending?.status).toBe("PENDING");
    expect(stillPending?.quantity).toBe(6);

    const confirm = await request(app).post(`/api/put-backs/${pendingTask.id}/confirm`).set(auth(warehouse.token));
    expect(confirm.status).toBe(200);
    expect(await stockAt(sku.id, loc.id)).toBe(before + 10);
  });
});
