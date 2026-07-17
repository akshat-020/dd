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

let skuCounter = 0;
async function skuWithStock(qty: number) {
  skuCounter += 1;
  const sku = await prisma.sku.create({ data: { code: `R2-SKU-${skuCounter}`, name: "Round2 Widget", unit: "pc" } });
  const loc = await prisma.location.create({ data: { code: `R2-LOC-${skuCounter}`, zone: "R2", rack: "01" } });
  await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, quantity: qty });
  return { sku, loc };
}

async function pickThrough(itemId: string, locationCode: string, skuCode: string, quantity: number) {
  await request(app).post(`/api/picking/items/${itemId}/scan-location`).set(auth(warehouse.token)).send({ locationCode });
  await request(app).post(`/api/picking/items/${itemId}/scan-sku`).set(auth(warehouse.token)).send({ label: skuCode });
  return request(app).post(`/api/picking/items/${itemId}/confirm`).set(auth(warehouse.token)).send({ quantity });
}

describe("#6 Requested is locked; Final Qty is the one editable quantity", () => {
  it("PATCH ignores qtyRequested on an existing line but applies qtyFinalized", async () => {
    const { sku } = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Locked Requested Buyer", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    const lineId = order.body.lines[0].id;

    const res = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineId, qtyRequested: 999, qtyFinalized: 8 }] });
    expect(res.status).toBe(200);
    expect(res.body.lines[0].qtyRequested).toBe(5);
    expect(res.body.lines[0].qtyFinalized).toBe(8);
  });
});

describe("#3 partial pick creates a shortfall follow-up and notifies (in-app)", () => {
  it("picking less than allocated keeps the order out of LOADED and generates a follow-up task", async () => {
    const { sku, loc } = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Shortfall Buyer", lines: [{ skuId: sku.id, qtyRequested: 10 }] });
    const finalizeRes = await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    expect(finalizeRes.status).toBe(200);

    const pickListBefore = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    expect(pickListBefore.body).toHaveLength(1);
    const item = pickListBefore.body[0];

    const confirmRes = await pickThrough(item.id, loc.code, sku.code, 7);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.status).toBe("PICKED");
    expect(confirmRes.body.qtyPicked).toBe(7);

    const orderAfter = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(orderAfter.body.status).toBe("FINALIZED"); // not LOADED — shortfall still outstanding

    const pickListAfter = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    expect(pickListAfter.body).toHaveLength(2);
    const followup = pickListAfter.body.find((i: any) => i.isShortfallFollowup);
    expect(followup).toBeTruthy();
    expect(followup.qtyToPick).toBe(3);
    expect(followup.status).toBe("PENDING");

    const shortfalls = await request(app).get("/api/reports/shortfalls").set(auth(owner.token));
    expect(shortfalls.status).toBe(200);
    const entry = shortfalls.body.find((s: any) => s.orderId === order.body.id);
    expect(entry).toBeTruthy();
    expect(entry.shortfallQty).toBe(3);

    // Finishing the follow-up task resolves it and completes the order.
    const finish = await pickThrough(followup.id, loc.code, sku.code, 3);
    expect(finish.status).toBe(200);
    const orderFinal = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(orderFinal.body.status).toBe("LOADED");

    const shortfallsAfter = await request(app).get("/api/reports/shortfalls").set(auth(owner.token));
    expect(shortfallsAfter.body.find((s: any) => s.orderId === order.body.id)).toBeUndefined();
  });

  it("/reports/shortfalls is restricted to Owner/Sales", async () => {
    const res = await request(app).get("/api/reports/shortfalls").set(auth(warehouse.token));
    expect(res.status).toBe(403);
  });
});

describe("#4 finalized orders stay editable and edits propagate to the pick list", () => {
  it("increasing Final Qty allocates more stock; decreasing releases unpicked allocation; reducing below picked queues a put-back", async () => {
    const { sku, loc } = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Propagation Buyer", lines: [{ skuId: sku.id, qtyRequested: 10 }] });
    const lineId = order.body.lines[0].id;
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    // A PICKED row's contribution to "how much of Final Qty this accounts
    // for" is what was actually picked, not its original qtyToPick target
    // (which can differ once a partial pick's shortfall becomes a separate
    // follow-up row) — see reconcileOrderLineAllocation.
    function totalAccountedFor(items: any[]) {
      return items.reduce((s: number, i: any) => s + (i.status === "PICKED" ? i.qtyPicked : i.qtyToPick), 0);
    }

    // Increase 10 -> 15
    const increase = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineId, qtyFinalized: 15 }] });
    expect(increase.status).toBe(200);
    let items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    expect(totalAccountedFor(items.body)).toBe(15);

    // Pick 7 of it so there's a real "already picked" floor.
    const firstItem = items.body[0];
    await pickThrough(firstItem.id, loc.code, sku.code, 7);

    // Decrease 15 -> 8 (above the 7 picked) should succeed, releasing the rest.
    const decrease = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineId, qtyFinalized: 8 }] });
    expect(decrease.status).toBe(200);
    items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    expect(totalAccountedFor(items.body)).toBe(8);

    // Reducing below the 7 already picked no longer errors — it queues a
    // put-back task for the excess instead (Round-4 operational-flow
    // addendum, item 4), since that stock is already physically picked and
    // has to come back to a shelf rather than just vanish from the count.
    const tooLow = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineId, qtyFinalized: 3 }] });
    expect(tooLow.status).toBe(200);

    const putBacks = await prisma.putBackTask.findMany({ where: { orderLineId: lineId, status: "PENDING" } });
    expect(putBacks.reduce((s, t) => s + t.quantity, 0)).toBe(4); // 7 picked - 3 new target

    // qtyPicked stays at 7 ("in limbo") until the put-back is physically
    // confirmed — it's not silently reconciled away just from the edit.
    items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const pickedItem = items.body.find((i: any) => i.status === "PICKED");
    expect(pickedItem.qtyPicked).toBe(7);
  });

  it("a new line added to a finalized order gets its own pick-list allocation", async () => {
    const { sku: sku1 } = await skuWithStock(10);
    const { sku: sku2 } = await skuWithStock(10);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Add Line After Finalize", lines: [{ skuId: sku1.id, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const addLine = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ skuId: sku2.id, qtyRequested: 4 }] });
    expect(addLine.status).toBe(200);
    expect(addLine.body.lines).toHaveLength(2);

    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const forNewSku = items.body.filter((i: any) => i.skuId === sku2.id);
    const allocated = forNewSku.reduce((s: number, i: any) => s + i.qtyToPick, 0);
    expect(allocated).toBe(4);
  });

  it("removing a line that's already been picked is rejected; an unpicked line can be removed", async () => {
    const { sku: skuA, loc: locA } = await skuWithStock(10);
    const { sku: skuB } = await skuWithStock(10);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({
        buyerName: "Remove Line Buyer",
        lines: [
          { skuId: skuA.id, qtyRequested: 5 },
          { skuId: skuB.id, qtyRequested: 5 },
        ],
      });
    const lineA = order.body.lines.find((l: any) => l.skuId === skuA.id);
    const lineB = order.body.lines.find((l: any) => l.skuId === skuB.id);
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const itemA = items.body.find((i: any) => i.skuId === skuA.id);
    await pickThrough(itemA.id, locA.code, skuA.code, 5);

    const removePickedLine = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineA.id, remove: true }] });
    expect(removePickedLine.status).toBe(409);

    const removeUnpickedLine = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineB.id, remove: true }] });
    expect(removeUnpickedLine.status).toBe(200);
    expect(removeUnpickedLine.body.lines.find((l: any) => l.id === lineB.id)).toBeUndefined();
  });

  it("a LOADED order stays editable (needed for post-pick put-back adjustments) but an INVOICED order is locked", async () => {
    const { sku, loc } = await skuWithStock(10);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Loaded Lock Buyer", lines: [{ skuId: sku.id, qtyRequested: 5 }] });
    const lineId = order.body.lines[0].id;
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 5);

    const loadedCheck = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(loadedCheck.body.status).toBe("LOADED");

    // A LOADED order is picked but not yet dispatched/invoiced — the
    // operational-flow addendum's post-pick adjustment scenario is exactly
    // this state, so editing (which can trigger a put-back) must still be
    // allowed here, not just on FINALIZED.
    const editAttempt = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ buyerName: "Edited while loaded" });
    expect(editAttempt.status).toBe(200);
    expect(editAttempt.body.buyerName).toBe("Edited while loaded");

    // Once actually invoiced, it's locked — the Invoice Reference layer
    // must never see a post-invoice edit.
    await request(app)
      .post("/api/invoice-references")
      .set(auth(owner.token))
      .send({ tallyInvoiceNumber: `LOCK-TEST-${Date.now()}`, orderId: order.body.id, lines: [{ skuId: sku.id, qty: 5, price: 1 }] });
    const invoicedCheck = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    expect(invoicedCheck.body.status).toBe("INVOICED");

    const editAfterInvoice = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineId, qtyFinalized: 1 }] });
    expect(editAfterInvoice.status).toBe(409);
  });
});

describe("#1 putaway task lifecycle: closes once the batch is fully shelved", () => {
  it("a fully-shelved batch drops out of /batches/recent and further putaway is rejected", async () => {
    const sku = await prisma.sku.create({ data: { code: "R2-BATCH-1", name: "Batch Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R2-BLOC-1", zone: "R2", rack: "02" } });
    const batchRes = await request(app)
      .post("/api/stock/batches")
      .set(auth(sales.token))
      .send({ skuId: sku.id, sourceType: "PURCHASE", receivedQuantity: 10 });
    const batchId = batchRes.body.id;

    const recentBefore = await request(app).get("/api/stock/batches/recent").set(auth(warehouse.token));
    const entryBefore = recentBefore.body.find((b: any) => b.id === batchId);
    expect(entryBefore.remainingToShelve).toBe(10);

    const putaway1 = await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, batchId, quantity: 6 });
    expect(putaway1.status).toBe(201);

    const recentMid = await request(app).get("/api/stock/batches/recent").set(auth(warehouse.token));
    expect(recentMid.body.find((b: any) => b.id === batchId).remainingToShelve).toBe(4);

    const overShelve = await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, batchId, quantity: 5 });
    expect(overShelve.status).toBe(409);

    const putaway2 = await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, batchId, quantity: 4 });
    expect(putaway2.status).toBe(201);

    const recentAfter = await request(app).get("/api/stock/batches/recent").set(auth(warehouse.token));
    expect(recentAfter.body.find((b: any) => b.id === batchId)).toBeUndefined();

    const furtherShelve = await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, batchId, quantity: 1 });
    expect(furtherShelve.status).toBe(409);
  });
});

describe("#5 location master edit + delete", () => {
  it("edits zone/rack/bin", async () => {
    const loc = await prisma.location.create({ data: { code: "R2-EDIT-1", zone: "A", rack: "01" } });
    const res = await request(app).patch(`/api/locations/${loc.id}`).set(auth(owner.token)).send({ zone: "B", rack: "02", bin: "03" });
    expect(res.status).toBe(200);
    expect(res.body.zone).toBe("B");
    expect(res.body.rack).toBe("02");
    expect(res.body.bin).toBe("03");
  });

  it("deletes a genuinely unused location outright", async () => {
    const loc = await prisma.location.create({ data: { code: "R2-DEL-UNUSED", zone: "A", rack: "01" } });
    const res = await request(app).delete(`/api/locations/${loc.id}`).set(auth(owner.token));
    expect(res.status).toBe(204);
    const gone = await prisma.location.findUnique({ where: { id: loc.id } });
    expect(gone).toBeNull();
  });

  it("blocks deletion while stock is assigned, and blocks hard-delete once there's movement history (offers deactivate instead)", async () => {
    const { sku, loc } = await skuWithStock(10);

    const blockedWithStock = await request(app).delete(`/api/locations/${loc.id}`).set(auth(owner.token));
    expect(blockedWithStock.status).toBe(409);

    const otherLoc = await prisma.location.create({ data: { code: "R2-DEL-DEST", zone: "A", rack: "09" } });
    const transfer = await request(app)
      .post("/api/stock/transfer")
      .set(auth(warehouse.token))
      .send({ skuId: sku.id, fromLocationId: loc.id, toLocationId: otherLoc.id, quantity: 10 });
    expect(transfer.status).toBe(201);

    const blockedWithHistory = await request(app).delete(`/api/locations/${loc.id}`).set(auth(owner.token));
    expect(blockedWithHistory.status).toBe(409);
    expect(blockedWithHistory.body.canDeactivate).toBe(true);

    const deactivate = await request(app).patch(`/api/locations/${loc.id}`).set(auth(owner.token)).send({ active: false });
    expect(deactivate.status).toBe(200);
    expect(deactivate.body.active).toBe(false);
  });
});

describe("#2 Warehouse has no general Orders access, but does have its own task history", () => {
  it("WAREHOUSE cannot list or fetch orders", async () => {
    const listRes = await request(app).get("/api/orders").set(auth(warehouse.token));
    expect(listRes.status).toBe(403);

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Perm Check Buyer", lines: [{ skuId: (await skuWithStock(5)).sku.id, qtyRequested: 1 }] });
    const getRes = await request(app).get(`/api/orders/${order.body.id}`).set(auth(warehouse.token));
    expect(getRes.status).toBe(403);
  });

  it("my-task-history reflects a warehouse account's own picks and putaways only", async () => {
    const { sku, loc } = await skuWithStock(10);
    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 5 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Task History Buyer", lines: [{ skuId: sku.id, qtyRequested: 3 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const items = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    await pickThrough(items.body[0].id, loc.code, sku.code, 3);

    const history = await request(app).get("/api/reports/my-task-history").set(auth(warehouse.token));
    expect(history.status).toBe(200);
    expect(history.body.picks.some((p: any) => p.skuCode === sku.code)).toBe(true);
    expect(history.body.putaways.some((p: any) => p.skuCode === sku.code)).toBe(true);
  });
});
