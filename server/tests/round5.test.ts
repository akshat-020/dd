import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let sales: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;
let accountant: Awaited<ReturnType<typeof createUser>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  [owner, sales, warehouse, accountant] = await Promise.all([
    createUser("OWNER"),
    createUser("SALES"),
    createUser("WAREHOUSE"),
    createUser("ACCOUNTANT"),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Multi-unit (Box/Pcs) conversion addendum", () => {
  it("creates a SKU with an alternate unit and conversion factor", async () => {
    const res = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R5-SKU-1", name: "Round5 Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 });
    expect(res.status).toBe(201);
    expect(res.body.altUnitName).toBe("Box");
    expect(res.body.altUnitFactor).toBe(10);
  });

  it("rejects altUnitName without altUnitFactor and vice versa", async () => {
    const res1 = await request(app).post("/api/skus").set(auth(owner.token)).send({ code: "R5-SKU-2", name: "X", unit: "pc", altUnitName: "Box" });
    expect(res1.status).toBe(400);
    const res2 = await request(app).post("/api/skus").set(auth(owner.token)).send({ code: "R5-SKU-3", name: "X", unit: "pc", altUnitFactor: 10 });
    expect(res2.status).toBe(400);
  });

  it("warns before changing an existing conversion factor on a SKU with stock, and applies it once confirmed", async () => {
    const sku = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R5-SKU-4", name: "Round5 Boxed", unit: "pc", altUnitName: "Box", altUnitFactor: 10 });
    const loc = await request(app).post("/api/locations").set(auth(owner.token)).send({ code: "R5-LOC-4", zone: "R5", rack: "01" });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.body.id, locationId: loc.body.id, quantity: 20 });

    const blocked = await request(app).patch(`/api/skus/${sku.body.id}`).set(auth(owner.token)).send({ altUnitFactor: 12 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.requiresConfirmation).toBe(true);

    const stillOld = await request(app).get(`/api/skus/${sku.body.id}`).set(auth(owner.token));
    expect(stillOld.body.altUnitFactor).toBe(10);

    const confirmed = await request(app)
      .patch(`/api/skus/${sku.body.id}`)
      .set(auth(owner.token))
      .send({ altUnitFactor: 12, confirmFactorChange: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.altUnitFactor).toBe(12);
  });

  it("does not warn when setting a conversion factor for the first time, even with existing stock", async () => {
    const sku = await request(app).post("/api/skus").set(auth(owner.token)).send({ code: "R5-SKU-5", name: "Round5 Plain", unit: "pc" });
    const loc = await request(app).post("/api/locations").set(auth(owner.token)).send({ code: "R5-LOC-5", zone: "R5", rack: "02" });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.body.id, locationId: loc.body.id, quantity: 5 });

    const res = await request(app).patch(`/api/skus/${sku.body.id}`).set(auth(owner.token)).send({ altUnitName: "Box", altUnitFactor: 10 });
    expect(res.status).toBe(200);
    expect(res.body.altUnitFactor).toBe(10);
  });

  it("order intake accepts a quantity in the alternate unit and converts to base units for stock math", async () => {
    const sku = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R5-SKU-6", name: "Round5 Order Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 });
    const loc = await request(app).post("/api/locations").set(auth(owner.token)).send({ code: "R5-LOC-6", zone: "R5", rack: "03" });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.body.id, locationId: loc.body.id, quantity: 100 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round5 Buyer", lines: [{ skuId: sku.body.id, qtyRequested: 5, unit: "Box" }] });
    expect(order.status).toBe(201);
    const line = order.body.lines[0];
    expect(line.qtyRequested).toBe(50); // 5 Box * 10 = 50 pcs, base-unit canonical
    expect(line.requestedUnit).toBe("Box");
    expect(line.requestedUnitQty).toBe(5);
    expect(line.requestedFactor).toBe(10);

    // Stock-check compares against base-unit availability.
    const check = await request(app).get(`/api/orders/${order.body.id}/stock-check`).set(auth(sales.token));
    expect(check.body[0].requested).toBe(50);
    expect(check.body[0].sufficient).toBe(true);
  });

  it("rejects an order line with a unit that isn't valid for the SKU", async () => {
    const sku = await request(app).post("/api/skus").set(auth(owner.token)).send({ code: "R5-SKU-7", name: "Round5 No Box", unit: "pc" });
    const res = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round5 Buyer 2", lines: [{ skuId: sku.body.id, qtyRequested: 1, unit: "Box" }] });
    expect(res.status).toBe(400);
  });

  it("editing Final Qty in a different unit converts and stores it correctly", async () => {
    const sku = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R5-SKU-8", name: "Round5 Final Qty", unit: "pc", altUnitName: "Box", altUnitFactor: 10 });
    const loc = await request(app).post("/api/locations").set(auth(owner.token)).send({ code: "R5-LOC-8", zone: "R5", rack: "04" });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.body.id, locationId: loc.body.id, quantity: 200 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round5 Buyer 3", lines: [{ skuId: sku.body.id, qtyRequested: 5, unit: "Box" }] });
    const lineId = order.body.lines[0].id;

    const updated = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineId, qtyFinalized: 45, unit: "pc" }] });
    expect(updated.status).toBe(200);
    const line = updated.body.lines.find((l: any) => l.id === lineId);
    expect(line.qtyFinalized).toBe(45);
    expect(line.finalUnit).toBe("pc");
    expect(line.finalUnitQty).toBe(45);
    expect(line.finalFactor).toBe(1);
  });

  it("stock-on-hand and standalone lookup include a compound Box/Pcs breakdown", async () => {
    const sku = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R5-SKU-9", name: "Round5 Compound", unit: "pc", altUnitName: "Box", altUnitFactor: 10 });
    const loc = await request(app).post("/api/locations").set(auth(owner.token)).send({ code: "R5-LOC-9", zone: "R5", rack: "05" });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.body.id, locationId: loc.body.id, quantity: 163 });

    const stockOnHand = await request(app).get("/api/reports/stock-on-hand").set(auth(owner.token));
    const row = stockOnHand.body.find((r: any) => r.skuId === sku.body.id);
    expect(row.compound).toEqual({ boxes: 16, pcs: 3, label: "16 Box + 3 pc" });

    const lookup = await request(app).get(`/api/stock/lookup/${sku.body.id}`).set(auth(sales.token));
    expect(lookup.body.totalQty).toBe(163);
    expect(lookup.body.compound.label).toBe("16 Box + 3 pc");
    expect(lookup.body.locations[0].compound.label).toBe("16 Box + 3 pc");
  });

  it("picking confirm accepts a box-break and records pickedUnit/pickedUnitQty/boxesOpened", async () => {
    const sku = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R5-SKU-10", name: "Round5 Pick Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 });
    const loc = await request(app).post("/api/locations").set(auth(owner.token)).send({ code: "R5-LOC-10", zone: "R5", rack: "06" });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.body.id, locationId: loc.body.id, quantity: 100 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round5 Pick Buyer", lines: [{ skuId: sku.body.id, qtyRequested: 25, unit: "pc" }] });
    await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ id: order.body.lines[0].id, qtyFinalized: 25, unit: "pc" }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    expect(item.qtyToPick).toBe(25); // 2 full boxes + 5 loose — needs a box break

    await request(app).post(`/api/picking/items/${item.id}/scan-location`).set(auth(warehouse.token)).send({ locationCode: item.location.code });
    await request(app).post(`/api/picking/items/${item.id}/scan-sku`).set(auth(warehouse.token)).send({ label: item.sku.code });

    const confirm = await request(app)
      .post(`/api/picking/items/${item.id}/confirm`)
      .set(auth(warehouse.token))
      .send({ quantity: 25, unit: "pc", unitQty: 25, boxesOpened: 1 });
    expect(confirm.status).toBe(200);
    expect(confirm.body.qtyPicked).toBe(25);
    expect(confirm.body.pickedUnit).toBe("pc");
    expect(confirm.body.pickedUnitQty).toBe(25);
    expect(confirm.body.boxesOpened).toBe(1);
  });

  it("invoice reference lines record the billed unit and reverse stock in base units on cancel", async () => {
    const sku = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R5-SKU-11", name: "Round5 Invoice Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 });
    const loc = await request(app).post("/api/locations").set(auth(owner.token)).send({ code: "R5-LOC-11", zone: "R5", rack: "07" });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.body.id, locationId: loc.body.id, quantity: 100 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round5 Invoice Buyer", lines: [{ skuId: sku.body.id, qtyRequested: 5, unit: "Box" }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(owner.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    await request(app).post(`/api/picking/items/${item.id}/scan-location`).set(auth(warehouse.token)).send({ locationCode: item.location.code });
    await request(app).post(`/api/picking/items/${item.id}/scan-sku`).set(auth(warehouse.token)).send({ label: item.sku.code });
    await request(app).post(`/api/picking/items/${item.id}/confirm`).set(auth(warehouse.token)).send({ quantity: 50, unit: "Box", unitQty: 5 });

    const ref = await request(app)
      .post("/api/invoice-references")
      .set(auth(accountant.token))
      .send({
        tallyInvoiceNumber: `R5-INV-${Date.now()}`,
        orderId: order.body.id,
        lines: [{ skuId: sku.body.id, qty: 5, unit: "Box", price: 450 }],
      });
    expect(ref.status).toBe(201);
    const line = ref.body.lines[0];
    expect(line.qty).toBe(5);
    expect(line.unit).toBe("Box");
    expect(line.unitFactor).toBe(10);
    expect(line.qtyBaseUnits).toBe(50);

    const before = await prisma.stockItem.findFirst({ where: { skuId: sku.body.id, locationId: loc.body.id } });

    const cancelled = await request(app)
      .post(`/api/invoice-references/${ref.body.id}/cancel`)
      .set(auth(accountant.token))
      .send({ reverseStock: true });
    expect(cancelled.status).toBe(200);

    const after = await prisma.stockItem.findFirst({ where: { skuId: sku.body.id, locationId: loc.body.id } });
    expect(after!.quantity - before!.quantity).toBe(50); // reversed in base units (pcs), not 5
  });
});
