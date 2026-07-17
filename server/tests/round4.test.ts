import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

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

describe("#4 standalone SKU -> location lookup, usable without an active pick task", () => {
  it("Owner and Sales can look up a SKU's current locations and quantity; Accountant and Warehouse cannot", async () => {
    const sku = await prisma.sku.create({ data: { code: "R4-SKU-1", name: "Round4 Widget", unit: "pc" } });
    const locA = await prisma.location.create({ data: { code: "R4-LOC-1A", zone: "R4", rack: "01" } });
    const locB = await prisma.location.create({ data: { code: "R4-LOC-1B", zone: "R4", rack: "01" } });

    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: locA.id, quantity: 40 });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: locB.id, quantity: 25 });

    const ownerRes = await request(app).get(`/api/stock/lookup/${sku.id}`).set(auth(owner.token));
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.body.totalQty).toBe(65);
    expect(ownerRes.body.locations).toHaveLength(2);

    const salesRes = await request(app).get(`/api/stock/lookup/${sku.id}`).set(auth(sales.token));
    expect(salesRes.status).toBe(200);
    expect(salesRes.body.totalQty).toBe(65);

    const accountantRes = await request(app).get(`/api/stock/lookup/${sku.id}`).set(auth(accountant.token));
    expect(accountantRes.status).toBe(403);

    const warehouseRes = await request(app).get(`/api/stock/lookup/${sku.id}`).set(auth(warehouse.token));
    expect(warehouseRes.status).toBe(403);
  });

  it("aggregates multiple batches at the same location into one entry, not one per batch", async () => {
    const sku = await prisma.sku.create({ data: { code: "R4-SKU-2", name: "Round4 Widget 2", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R4-LOC-2", zone: "R4", rack: "02" } });

    const batchA = await request(app).post("/api/stock/batches").set(auth(owner.token)).send({ skuId: sku.id, sourceType: "PURCHASE", receivedQuantity: 30 });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, batchId: batchA.body.id, quantity: 30 });
    const batchB = await request(app).post("/api/stock/batches").set(auth(owner.token)).send({ skuId: sku.id, sourceType: "PURCHASE", receivedQuantity: 12 });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, batchId: batchB.body.id, quantity: 12 });

    const res = await request(app).get(`/api/stock/lookup/${sku.id}`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0].quantity).toBe(42);
    expect(res.body.totalQty).toBe(42);
  });

  it("404s for an unknown SKU id", async () => {
    const res = await request(app).get("/api/stock/lookup/does-not-exist").set(auth(owner.token));
    expect(res.status).toBe(404);
  });
});
