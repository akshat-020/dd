import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

// Picking Flow — Allow Skipping a Blocked Item: a "Skip / report issue"
// action, available from any pre-PICKED status, that reuses the existing
// partial-pick shortfall mechanism (a 0-of-N pick) rather than a separate
// code path, so a blocked item never holds up the rest of the order.

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
  const sku = await prisma.sku.create({ data: { code: `R14-SKU-${skuCounter}`, name: "Round14 Widget", unit: "pc" } });
  const loc = await prisma.location.create({ data: { code: `R14-LOC-${skuCounter}`, zone: "R14", rack: "01" } });
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

describe("Picking Flow — Skip / report issue", () => {
  it("skipping a never-touched item moves it to PICKED/isSkipped, leaves stock untouched, and creates a follow-up task", async () => {
    const { sku, loc } = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Skip Buyer 1", lines: [{ skuId: sku.id, qtyRequested: 10 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    expect(item.status).toBe("PENDING"); // never scanned — skip must work from here too

    const before = await stockAt(sku.id, loc.id);

    const skipRes = await request(app).post(`/api/picking/items/${item.id}/skip`).set(auth(warehouse.token)).send({ reason: "Out of stock" });
    expect(skipRes.status).toBe(200);
    expect(skipRes.body.status).toBe("PICKED");
    expect(skipRes.body.qtyPicked).toBe(0);
    expect(skipRes.body.isSkipped).toBe(true);
    expect(skipRes.body.note).toContain("Out of stock");

    // No physical pick occurred, so no stock movement.
    const after = await stockAt(sku.id, loc.id);
    expect(after).toBe(before);

    const pickListAfter = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    expect(pickListAfter.body).toHaveLength(2);
    const followup = pickListAfter.body.find((i: any) => i.isShortfallFollowup);
    expect(followup).toBeTruthy();
    expect(followup.qtyToPick).toBe(10);
    expect(followup.status).toBe("PENDING");
    expect(followup.note).toContain("skipped");
  });

  it("skipping one line immediately unblocks the next line and still lets the order reach LOADED", async () => {
    const { sku: skuA, loc: locA } = await skuWithStock(20);
    const { sku: skuB, loc: locB } = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({
        buyerName: "Skip Buyer 2",
        lines: [
          { skuId: skuA.id, qtyRequested: 5 },
          { skuId: skuB.id, qtyRequested: 5 },
        ],
      });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const itemA = pickList.body.find((i: any) => i.skuId === skuA.id);
    const itemB = pickList.body.find((i: any) => i.skuId === skuB.id);

    // Item 1 is blocked (damaged) — skip it instead of getting stuck.
    const skipRes = await request(app).post(`/api/picking/items/${itemA.id}/skip`).set(auth(warehouse.token)).send({ reason: "Damaged" });
    expect(skipRes.status).toBe(200);

    // Item 2 has nothing wrong with it and completes normally.
    const finishB = await pickThrough(itemB.id, locB.code, skuB.code, 5);
    expect(finishB.status).toBe(200);

    const orderAfter = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(orderAfter.body.status).toBe("LOADED"); // not blocked by item A's outstanding shortfall

    const shortfalls = await request(app).get("/api/reports/shortfalls").set(auth(owner.token));
    const entry = shortfalls.body.find((s: any) => s.orderId === order.body.id);
    expect(entry).toBeTruthy();
    expect(entry.shortfallQty).toBe(5);
    expect(entry.note).toContain("Damaged");
  });

  it("the picker can return to a skipped item's follow-up later in the same session and complete it normally", async () => {
    const { sku, loc } = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Skip Buyer 3", lines: [{ skuId: sku.id, qtyRequested: 6 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    await request(app).post(`/api/picking/items/${item.id}/skip`).set(auth(warehouse.token)).send({ reason: "Checking with supervisor" });

    const orderMidway = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(orderMidway.body.status).toBe("LOADED"); // already loaded despite the outstanding follow-up

    const pickListAfter = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const followup = pickListAfter.body.find((i: any) => i.isShortfallFollowup);

    // Found it after all — pick the follow-up the normal way.
    const finish = await pickThrough(followup.id, loc.code, sku.code, 6);
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe("PICKED");
    expect(finish.body.qtyPicked).toBe(6);

    const shortfallsAfter = await request(app).get("/api/reports/shortfalls").set(auth(owner.token));
    expect(shortfallsAfter.body.find((s: any) => s.orderId === order.body.id)).toBeUndefined();

    const orderFinal = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(orderFinal.body.status).toBe("LOADED");
  });

  it("rejects skipping an already-picked item, and gives a distinct message for re-skipping an already-skipped item", async () => {
    const { sku, loc } = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Skip Buyer 4", lines: [{ skuId: sku.id, qtyRequested: 4 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];

    await pickThrough(item.id, loc.code, sku.code, 4);
    const skipPicked = await request(app).post(`/api/picking/items/${item.id}/skip`).set(auth(warehouse.token)).send({ reason: "too late" });
    expect(skipPicked.status).toBe(409);
    expect(skipPicked.body.error).toMatch(/already picked/i);

    // A separate item that gets skipped, then skipped again.
    const order2 = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Skip Buyer 5", lines: [{ skuId: sku.id, qtyRequested: 2 }] });
    await request(app).post(`/api/orders/${order2.body.id}/finalize`).set(auth(sales.token));
    const pickList2 = await request(app).get(`/api/picking/orders/${order2.body.id}`).set(auth(warehouse.token));
    const item2 = pickList2.body[0];
    await request(app).post(`/api/picking/items/${item2.id}/skip`).set(auth(warehouse.token)).send({ reason: "OOS" });
    const reskip = await request(app).post(`/api/picking/items/${item2.id}/skip`).set(auth(warehouse.token)).send({ reason: "OOS again" });
    expect(reskip.status).toBe(409);
    expect(reskip.body.error).toMatch(/already skipped/i);
  });

  it("requires a non-empty reason, and requires inventory.scanPutaway (Sales rejected)", async () => {
    const { sku } = await skuWithStock(10);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Skip Buyer 6", lines: [{ skuId: sku.id, qtyRequested: 3 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];

    const noReason = await request(app).post(`/api/picking/items/${item.id}/skip`).set(auth(warehouse.token)).send({});
    expect(noReason.status).toBe(400);

    const asSales = await request(app).post(`/api/picking/items/${item.id}/skip`).set(auth(sales.token)).send({ reason: "OOS" });
    expect(asSales.status).toBe(403);
  });

  it("records a PICK_SKIP audit entry alongside PICK_SHORTFALL", async () => {
    const { sku } = await skuWithStock(10);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Skip Buyer 7", lines: [{ skuId: sku.id, qtyRequested: 3 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];

    await request(app).post(`/api/picking/items/${item.id}/skip`).set(auth(warehouse.token)).send({ reason: "Wrong quantity found" });

    const audit = await request(app).get(`/api/orders/${order.body.id}/audit`).set(auth(owner.token));
    expect(audit.status).toBe(200);
    const skipEntry = audit.body.find((e: any) => e.action === "PICK_SKIP");
    expect(skipEntry).toBeTruthy();
    expect(skipEntry.summary).toContain("Wrong quantity found");
    const shortfallEntry = audit.body.find((e: any) => e.action === "PICK_SHORTFALL" && e.entityType === "PickListItem");
    expect(shortfallEntry).toBeTruthy();
  });
});
