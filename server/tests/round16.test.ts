import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

// Bug fix: cancelling an order with a *pre-existing* pending put-back (from
// an earlier Final Qty reduction that hasn't been physically confirmed yet)
// could queue a second, overlapping put-back task against the same already-
// fully-covered pick item — over the item's own qtyPicked — while another
// item on the same line that genuinely still owed a return went unqueued.
// Confirming both tasks fabricated extra stock at one location and silently
// lost the return at the other. See reconcileOrderLineAllocation's decrease
// branch in lib/stock.ts.

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

async function pickThrough(itemId: string, locationCode: string, skuCode: string, quantity: number) {
  await request(app).post(`/api/picking/items/${itemId}/scan-location`).set(auth(warehouse.token)).send({ locationCode });
  await request(app).post(`/api/picking/items/${itemId}/scan-sku`).set(auth(warehouse.token)).send({ label: skuCode });
  return request(app).post(`/api/picking/items/${itemId}/confirm`).set(auth(warehouse.token)).send({ quantity });
}

async function stockAt(skuId: string, locationId: string) {
  const row = await prisma.stockItem.findFirst({ where: { skuId, locationId } });
  return row?.quantity ?? 0;
}

describe("Cancel put-back — no double-counting against a pick item with a pre-existing pending put-back", () => {
  it("cancelling after an earlier Final Qty reduction queues put-backs that sum exactly to what's still picked per item, not more", async () => {
    const sku = await prisma.sku.create({ data: { code: "R16-SKU-1", name: "Round16 Widget", unit: "pc" } });
    // Two distinct on-hand quantities so finalize's greedy allocation
    // (largest stock cell first) deterministically splits the line's pick
    // across two locations instead of satisfying it from one.
    const locBig = await prisma.location.create({ data: { code: "R16-LOC-BIG", zone: "R16", rack: "01" } });
    const locSmall = await prisma.location.create({ data: { code: "R16-LOC-SMALL", zone: "R16", rack: "02" } });
    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: locBig.id, quantity: 6 });
    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: locSmall.id, quantity: 4 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round16 Buyer", lines: [{ skuId: sku.id, qtyRequested: 10 }] });
    const lineId = order.body.lines[0].id;
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    expect(pickList.body).toHaveLength(2); // split across the two locations
    const itemBig = pickList.body.find((i: any) => i.locationId === locBig.id);
    const itemSmall = pickList.body.find((i: any) => i.locationId === locSmall.id);

    await pickThrough(itemBig.id, locBig.code, sku.code, 6);
    await pickThrough(itemSmall.id, locSmall.code, sku.code, 4);

    // Reduce Final Qty 10 -> 4 (a reduction of 6) while both items are
    // fully picked. Sequence order means the more-recently-created item is
    // released from first; whichever item that unbalanced draw lands on,
    // it should never exceed that item's own qtyPicked.
    const reduce = await request(app)
      .patch(`/api/orders/${order.body.id}`)
      .set(auth(sales.token))
      .send({ lines: [{ id: lineId, qtyFinalized: 4 }] });
    expect(reduce.status).toBe(200);

    const afterReduce = await prisma.putBackTask.findMany({ where: { orderId: order.body.id }, orderBy: { createdAt: "asc" } });
    const pendingTotalAfterReduce = afterReduce.reduce((s, t) => s + t.quantity, 0);
    expect(pendingTotalAfterReduce).toBe(6); // exactly the reduction, none confirmed yet

    // Cancel the whole order before any put-back is physically confirmed.
    const cancelRes = await request(app).post(`/api/orders/${order.body.id}/cancel`).set(auth(owner.token));
    expect(cancelRes.status).toBe(200);

    const allTasks = await prisma.putBackTask.findMany({ where: { orderId: order.body.id } });
    const byItem = new Map<string, number>();
    for (const t of allTasks) {
      byItem.set(t.sourcePickListItemId, (byItem.get(t.sourcePickListItemId) ?? 0) + t.quantity);
    }
    // The core invariant: no single pick item ever has more pending
    // put-back quantity queued against it than it actually picked.
    for (const [itemId, total] of byItem) {
      const item = await prisma.pickListItem.findUnique({ where: { id: itemId } });
      expect(total).toBeLessThanOrEqual(item!.qtyPicked);
    }
    // And in aggregate, cancelling shouldn't manufacture or lose quantity —
    // every unit ever picked for this line (10) must be queued for return
    // exactly once.
    const grandTotal = allTasks.reduce((s, t) => s + t.quantity, 0);
    expect(grandTotal).toBe(10);

    // Confirm every pending put-back and verify the physical stock at each
    // location lands back at exactly what was originally there — not
    // inflated at one location while the other comes up short.
    const pending = await prisma.putBackTask.findMany({ where: { orderId: order.body.id, status: "PENDING" } });
    for (const task of pending) {
      const res = await request(app).post(`/api/put-backs/${task.id}/confirm`).set(auth(warehouse.token));
      expect(res.status).toBe(200);
    }

    expect(await stockAt(sku.id, locBig.id)).toBe(6);
    expect(await stockAt(sku.id, locSmall.id)).toBe(4);
  });
});
