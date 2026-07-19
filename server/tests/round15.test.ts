import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

// Bug fix: an order stuck in LOADED (fully picked, staged, awaiting Mark
// Dispatched) was silently disappearing from the default Orders view the
// moment it aged past the 3-day recency window — before anyone even had a
// chance to dispatch it — because LOADED was lumped in with the concluded
// COMPLETED/CANCELLED statuses instead of the "still active" bucket. And a
// just-dispatched old order vanished immediately too, since only createdAt
// (not completedAt) was checked. See routes/orders.ts's default-view filter.

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

let skuCounter = 0;
async function skuWithStock(qty: number) {
  skuCounter += 1;
  const sku = await prisma.sku.create({ data: { code: `R15-SKU-${skuCounter}`, name: "Round15 Widget", unit: "pc" } });
  const loc = await prisma.location.create({ data: { code: `R15-LOC-${skuCounter}`, zone: "R15", rack: "01" } });
  await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, quantity: qty });
  return { sku, loc };
}

async function pickThrough(itemId: string, locationCode: string, skuCode: string, quantity: number) {
  await request(app).post(`/api/picking/items/${itemId}/scan-location`).set(auth(warehouse.token)).send({ locationCode });
  await request(app).post(`/api/picking/items/${itemId}/scan-sku`).set(auth(warehouse.token)).send({ label: skuCode });
  return request(app).post(`/api/picking/items/${itemId}/confirm`).set(auth(warehouse.token)).send({ quantity });
}

describe("Orders default view — LOADED and just-dispatched orders don't vanish", () => {
  it("an old order stuck in LOADED stays visible in the default view — it's still awaiting dispatch", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round15 Old Loaded", lines: [{ skuId: sku.id, qtyRequested: 3 }] });
    await prisma.order.update({ where: { id: order.body.id }, data: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } });

    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    await pickThrough(item.id, loc.code, sku.code, 3);

    const check = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(check.body.status).toBe("LOADED");

    const list = await request(app).get("/api/orders").set(auth(sales.token));
    expect(list.body.some((o: any) => o.id === order.body.id)).toBe(true);
  });

  it("an old order just marked dispatched stays visible for a grace window off completedAt, not just createdAt", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round15 Old Dispatched", lines: [{ skuId: sku.id, qtyRequested: 2 }] });
    await prisma.order.update({ where: { id: order.body.id }, data: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } });

    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    await pickThrough(item.id, loc.code, sku.code, 2);

    const dispatchRes = await request(app).post(`/api/orders/${order.body.id}/dispatch`).set(auth(sales.token));
    expect(dispatchRes.status).toBe(200);
    expect(dispatchRes.body.status).toBe("COMPLETED");

    const list = await request(app).get("/api/orders").set(auth(sales.token));
    expect(list.body.some((o: any) => o.id === order.body.id)).toBe(true);
  });

  it("an old order dispatched long ago (stale completedAt too) still ages out of the default view", async () => {
    const { sku } = await skuWithStock(5);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round15 Long Ago Dispatched", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await prisma.order.update({ where: { id: order.body.id }, data: { status: "COMPLETED", createdAt: oldDate, completedAt: oldDate } });

    const list = await request(app).get("/api/orders").set(auth(sales.token));
    expect(list.body.some((o: any) => o.id === order.body.id)).toBe(false);

    // Still reachable with an explicit search — for someone who holds
    // orders.viewFullHistory (Sales doesn't, by default; see round9's
    // "hard ceiling" test), a search bypasses the default recency filter.
    const searched = await request(app).get("/api/orders?search=Round15 Long Ago Dispatched").set(auth(owner.token));
    expect(searched.body.some((o: any) => o.id === order.body.id)).toBe(true);
  });
});
