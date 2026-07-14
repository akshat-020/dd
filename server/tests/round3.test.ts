import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  [owner, warehouse] = await Promise.all([createUser("OWNER"), createUser("WAREHOUSE")]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("#3 stock-on-hand aggregates one row per SKU+location, batches nested underneath", () => {
  it("receiving the same SKU as two separate batches at the same location produces one combined row", async () => {
    const sku = await prisma.sku.create({ data: { code: "R3-SKU-1", name: "Round3 Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R3-LOC-1", zone: "R3", rack: "01" } });

    const batchA = await request(app)
      .post("/api/stock/batches")
      .set(auth(owner.token))
      .send({ skuId: sku.id, sourceType: "PURCHASE", receivedQuantity: 100 });
    await request(app)
      .post("/api/stock/putaway")
      .set(auth(warehouse.token))
      .send({ skuId: sku.id, locationId: loc.id, batchId: batchA.body.id, quantity: 100 });

    const batchB = await request(app)
      .post("/api/stock/batches")
      .set(auth(owner.token))
      .send({ skuId: sku.id, sourceType: "PURCHASE", receivedQuantity: 65 });
    await request(app)
      .post("/api/stock/putaway")
      .set(auth(warehouse.token))
      .send({ skuId: sku.id, locationId: loc.id, batchId: batchB.body.id, quantity: 65 });

    const res = await request(app).get("/api/reports/stock-on-hand").set(auth(owner.token));
    expect(res.status).toBe(200);
    const rowsForThisSkuLocation = res.body.filter((r: any) => r.skuId === sku.id && r.locationId === loc.id);
    expect(rowsForThisSkuLocation).toHaveLength(1); // not two rows, one per batch

    const row = rowsForThisSkuLocation[0];
    expect(row.quantity).toBe(165);
    expect(row.batches).toHaveLength(2);
    const batchQtys = row.batches.map((b: any) => b.quantity).sort((a: number, b: number) => a - b);
    expect(batchQtys).toEqual([65, 100]);
    expect(row.batches.every((b: any) => typeof b.batchCode === "string")).toBe(true);
  });

  it("the same SKU at two different locations still shows as two separate rows", async () => {
    const sku = await prisma.sku.create({ data: { code: "R3-SKU-2", name: "Round3 Widget 2", unit: "pc" } });
    const locA = await prisma.location.create({ data: { code: "R3-LOC-2A", zone: "R3", rack: "02" } });
    const locB = await prisma.location.create({ data: { code: "R3-LOC-2B", zone: "R3", rack: "02" } });

    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: locA.id, quantity: 10 });
    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: locB.id, quantity: 20 });

    const res = await request(app).get("/api/reports/stock-on-hand").set(auth(owner.token));
    const rowsForThisSku = res.body.filter((r: any) => r.skuId === sku.id);
    expect(rowsForThisSku).toHaveLength(2);
    expect(rowsForThisSku.find((r: any) => r.locationId === locA.id).quantity).toBe(10);
    expect(rowsForThisSku.find((r: any) => r.locationId === locB.id).quantity).toBe(20);
  });
});
