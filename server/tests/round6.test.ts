import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let sales: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  [owner, sales, warehouse] = await Promise.all([createUser("OWNER"), createUser("SALES"), createUser("WAREHOUSE")]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function scanAndConfirm(itemId: string, item: any, quantity: number) {
  await request(app).post(`/api/picking/items/${itemId}/scan-location`).set(auth(warehouse.token)).send({ locationCode: item.location.code });
  await request(app).post(`/api/picking/items/${itemId}/scan-sku`).set(auth(warehouse.token)).send({ label: item.sku.code });
  return request(app).post(`/api/picking/items/${itemId}/confirm`).set(auth(warehouse.token)).send({ quantity });
}

describe("#6 pick-list allocation is scoped per order line, not per (order, SKU)", () => {
  it("finalize splits pick items correctly across two lines of the same SKU, without double- or under-allocating", async () => {
    const sku = await prisma.sku.create({ data: { code: "R6-SKU-1", name: "Round6 Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R6-LOC-1", zone: "R6", rack: "01" } });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 100 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round6 Buyer", lines: [{ skuId: sku.id, qtyRequested: 30 }] });
    const line1Id = order.body.lines[0].id;
    // Add a second line for the *same* SKU.
    const added = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ skuId: sku.id, qtyRequested: 40 }] });
    const line2 = added.body.lines.find((l: any) => l.id !== line1Id);

    const finalize = await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    expect(finalize.status).toBe(200);

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const totalAllocated = pickList.body.reduce((sum: number, i: any) => sum + i.qtyToPick, 0);
    expect(totalAllocated).toBe(70); // 30 + 40, not 60 (double-counted) or short

    const forLine1 = pickList.body.filter((i: any) => i.orderLineId === line1Id);
    const forLine2 = pickList.body.filter((i: any) => i.orderLineId === line2.id);
    expect(forLine1.reduce((s: number, i: any) => s + i.qtyToPick, 0)).toBe(30);
    expect(forLine2.reduce((s: number, i: any) => s + i.qtyToPick, 0)).toBe(40);
  });

  it("finalize reports a shortfall when two lines of the same SKU jointly exceed on-hand stock", async () => {
    const sku = await prisma.sku.create({ data: { code: "R6-SKU-2", name: "Round6 Scarce Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R6-LOC-2", zone: "R6", rack: "02" } });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 100 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round6 Buyer 2", lines: [{ skuId: sku.id, qtyRequested: 60 }] });
    await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ skuId: sku.id, qtyRequested: 60 }] });

    const finalize = await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    expect(finalize.status).toBe(409);
    // The first line's 60 is checked against the full 100 and passes; the
    // second line's 60 is then checked against what's left (100 - 60 = 40)
    // and correctly comes up short — proving the two lines' demand for the
    // same SKU accumulates instead of each being checked independently
    // against the raw on-hand figure (which would let both "pass").
    expect(finalize.body.shortfalls[0].requested).toBe(60);
    expect(finalize.body.shortfalls[0].available).toBe(40);

    // Nothing should have been allocated since the whole finalize aborts.
    const check = await prisma.pickListItem.findMany({ where: { orderId: order.body.id } });
    expect(check).toHaveLength(0);
  });

  it("editing one line's Final Qty after finalize does not touch a sibling line's allocation", async () => {
    const sku = await prisma.sku.create({ data: { code: "R6-SKU-3", name: "Round6 Edit Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R6-LOC-3", zone: "R6", rack: "03" } });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 1087 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round6 Buyer 3", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const line1Id = order.body.lines[0].id;
    const added = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const line2 = added.body.lines.find((l: any) => l.id !== line1Id);

    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    // Edit line 2's Final Qty from 1 to 10 — mirrors the exact bug report.
    const updated = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: line2.id, qtyFinalized: 10 }] });
    expect(updated.status).toBe(200);

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const forLine1 = pickList.body.filter((i: any) => i.orderLineId === line1Id);
    const forLine2 = pickList.body.filter((i: any) => i.orderLineId === line2.id);
    expect(forLine1.reduce((s: number, i: any) => s + i.qtyToPick, 0)).toBe(1); // untouched
    expect(forLine2.reduce((s: number, i: any) => s + i.qtyToPick, 0)).toBe(10); // full 10, not 9

    const totalAllocated = pickList.body.reduce((sum: number, i: any) => sum + i.qtyToPick, 0);
    expect(totalAllocated).toBe(11); // 1 + 10, matching true combined demand
  });

  it("removing one line of a finalized order does not delete a sibling line's pick items", async () => {
    const sku = await prisma.sku.create({ data: { code: "R6-SKU-4", name: "Round6 Remove Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R6-LOC-4", zone: "R6", rack: "04" } });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 100 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round6 Buyer 4", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    const line1Id = order.body.lines[0].id;
    const added = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ skuId: sku.id, qtyRequested: 7 }] });
    const line2 = added.body.lines.find((l: any) => l.id !== line1Id);

    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ id: line2.id, remove: true }] });

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const totalAllocated = pickList.body.reduce((sum: number, i: any) => sum + i.qtyToPick, 0);
    expect(totalAllocated).toBe(5); // line 1's allocation survives untouched
    expect(pickList.body.every((i: any) => i.orderLineId === line1Id)).toBe(true);
  });

  it("picking confirm credits the correct order line's qtyPicked when two lines share a SKU", async () => {
    const sku = await prisma.sku.create({ data: { code: "R6-SKU-5", name: "Round6 Confirm Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R6-LOC-5", zone: "R6", rack: "05" } });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 100 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round6 Buyer 5", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    const line1Id = order.body.lines[0].id;
    const added = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ skuId: sku.id, qtyRequested: 20 }] });
    const line2 = added.body.lines.find((l: any) => l.id !== line1Id);

    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item1 = pickList.body.find((i: any) => i.orderLineId === line1Id);
    const item2 = pickList.body.find((i: any) => i.orderLineId === line2.id);

    await scanAndConfirm(item1.id, item1, item1.qtyToPick);
    await scanAndConfirm(item2.id, item2, item2.qtyToPick);

    const finalOrder = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    const finalLine1 = finalOrder.body.lines.find((l: any) => l.id === line1Id);
    const finalLine2 = finalOrder.body.lines.find((l: any) => l.id === line2.id);
    expect(finalLine1.qtyPicked).toBe(5);
    expect(finalLine2.qtyPicked).toBe(20);
  });
});
