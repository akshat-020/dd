import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let salesA: Awaited<ReturnType<typeof createUser>>;
let salesB: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;

let skuId: string;
let locationId: string;

beforeAll(async () => {
  [owner, salesA, salesB, warehouse] = await Promise.all([
    createUser("OWNER"),
    createUser("SALES"),
    createUser("SALES"),
    createUser("WAREHOUSE"),
  ]);
  const sku = await prisma.sku.create({ data: { code: "BUGFIX-SKU-1", name: "Bugfix Widget", unit: "pc" } });
  skuId = sku.id;
  const loc = await prisma.location.create({ data: { code: "BF-01-01", zone: "BF", rack: "01", bin: "01" } });
  locationId = loc.id;
  await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId, locationId, quantity: 20 });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("SKU master is editable", () => {
  it("OWNER can update name/unit/category/reorderThreshold; code is untouched", async () => {
    const sku = await prisma.sku.create({ data: { code: "EDIT-SKU-1", name: "Old Name", unit: "pc" } });
    const res = await request(app)
      .patch(`/api/skus/${sku.id}`)
      .set(auth(owner.token))
      .send({ name: "New Name", unit: "kg", category: "Hardware", reorderThreshold: 10 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
    expect(res.body.unit).toBe("kg");
    expect(res.body.category).toBe("Hardware");
    expect(res.body.reorderThreshold).toBe(10);
    expect(res.body.code).toBe("EDIT-SKU-1");
  });

  it("SALES cannot edit SKU master data", async () => {
    const sku = await prisma.sku.create({ data: { code: "EDIT-SKU-2", name: "Locked", unit: "pc" } });
    const res = await request(app).patch(`/api/skus/${sku.id}`).set(auth(salesA.token)).send({ name: "Hacked" });
    expect(res.status).toBe(403);
  });
});

// Each test below gets its own SKU + stock rather than sharing `skuId` — a
// failed assertion mid-test would otherwise skip that test's own cleanup
// and leave a stray commitment that poisons every later test on a shared
// SKU (exactly the kind of cross-order interference this fix is about).
let skuCounter = 0;
async function skuWithStock(qty: number): Promise<string> {
  skuCounter += 1;
  const sku = await prisma.sku.create({ data: { code: `BUGFIX-COMMIT-${skuCounter}`, name: "Commitment Test Widget", unit: "pc" } });
  await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId, quantity: qty });
  return sku.id;
}

describe("stock availability accounts for other orders' commitments", () => {
  it("two draft orders that together exceed on-hand stock are both flagged insufficient", async () => {
    const sku = await skuWithStock(20);
    const order1 = await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Draft Buyer 1", lines: [{ skuId: sku, qtyRequested: 12 }] });
    const order2 = await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Draft Buyer 2", lines: [{ skuId: sku, qtyRequested: 12 }] });

    // 20 on hand, 12 + 12 requested across the two drafts — neither can
    // truthfully be told "sufficient" against the same 20 units.
    const check1 = await request(app).get(`/api/orders/${order1.body.id}/stock-check`).set(auth(salesA.token));
    const check2 = await request(app).get(`/api/orders/${order2.body.id}/stock-check`).set(auth(salesA.token));
    expect(check1.body[0].committedElsewhere).toBe(12);
    expect(check1.body[0].available).toBe(8);
    expect(check1.body[0].sufficient).toBe(false);
    expect(check2.body[0].committedElsewhere).toBe(12);
    expect(check2.body[0].sufficient).toBe(false);
  });

  it("a draft's own stock-check does not count itself as committed elsewhere", async () => {
    const sku = await skuWithStock(20);
    const order = await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Solo Buyer", lines: [{ skuId: sku, qtyRequested: 20 }] });
    const check = await request(app).get(`/api/orders/${order.body.id}/stock-check`).set(auth(salesA.token));
    expect(check.body[0].committedElsewhere).toBe(0);
    expect(check.body[0].available).toBe(20);
    expect(check.body[0].sufficient).toBe(true);
  });

  it("finalize itself rejects an order that would oversell stock already committed to another order", async () => {
    const sku = await skuWithStock(20);
    const order1 = await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Finalize First", lines: [{ skuId: sku, qtyRequested: 12 }] });
    const finalize1 = await request(app).post(`/api/orders/${order1.body.id}/finalize`).set(auth(salesA.token));
    expect(finalize1.status).toBe(200);

    // order1 is FINALIZED but not yet picked, so its 12 units are still
    // "owed" — StockItem itself hasn't been decremented yet (that only
    // happens at physical pick-confirm), so a naive on-hand check would
    // wrongly see the full 20 as free.
    const order2 = await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Finalize Second", lines: [{ skuId: sku, qtyRequested: 10 }] });
    const finalize2 = await request(app).post(`/api/orders/${order2.body.id}/finalize`).set(auth(salesA.token));
    expect(finalize2.status).toBe(409);
    expect(finalize2.body.shortfalls[0].available).toBe(8); // 20 on hand - 12 committed to order1

    const order2After = await prisma.order.findUnique({ where: { id: order2.body.id } });
    expect(order2After?.status).toBe("DRAFT");
  });

  it("/stock/summary exposes availableQty (on-hand minus committed), not just raw totalQty", async () => {
    const sku = await skuWithStock(20);
    await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Summary Buyer", lines: [{ skuId: sku, qtyRequested: 7 }] });
    const summary = await request(app).get("/api/stock/summary").set(auth(salesA.token));
    const entry = summary.body.find((e: any) => e.skuId === sku);
    expect(entry.totalQty).toBe(20);
    expect(entry.committedQty).toBe(7);
    expect(entry.availableQty).toBe(13);
  });
});

describe("draft orders are visible only to their creator (+ Owner)", () => {
  it("another SALES account cannot list, fetch, or edit someone else's draft", async () => {
    const draft = await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Private Draft", lines: [{ skuId, qtyRequested: 1 }] });
    const draftId = draft.body.id;

    const listAll = await request(app).get("/api/orders").set(auth(salesB.token));
    expect(listAll.body.find((o: any) => o.id === draftId)).toBeUndefined();

    const listDrafts = await request(app).get("/api/orders?status=DRAFT").set(auth(salesB.token));
    expect(listDrafts.body.find((o: any) => o.id === draftId)).toBeUndefined();

    const getOne = await request(app).get(`/api/orders/${draftId}`).set(auth(salesB.token));
    expect(getOne.status).toBe(404);

    const patch = await request(app).patch(`/api/orders/${draftId}`).set(auth(salesB.token)).send({ buyerName: "Hijacked" });
    expect(patch.status).toBe(404);

    const finalize = await request(app).post(`/api/orders/${draftId}/finalize`).set(auth(salesB.token));
    expect(finalize.status).toBe(404);

    const stockCheck = await request(app).get(`/api/orders/${draftId}/stock-check`).set(auth(salesB.token));
    expect(stockCheck.status).toBe(404);

    // The creator and Owner both still see it fine.
    const asCreator = await request(app).get(`/api/orders/${draftId}`).set(auth(salesA.token));
    expect(asCreator.status).toBe(200);
    const asOwner = await request(app).get(`/api/orders/${draftId}`).set(auth(owner.token));
    expect(asOwner.status).toBe(200);

    await request(app).post(`/api/orders/${draftId}/cancel`).set(auth(owner.token));
  });

  it("becomes visible to other roles once finalized", async () => {
    const draft = await request(app)
      .post("/api/orders")
      .set(auth(salesA.token))
      .send({ buyerName: "Soon Public", lines: [{ skuId, qtyRequested: 1 }] });
    const draftId = draft.body.id;

    const hiddenWhileDraft = await request(app).get(`/api/orders/${draftId}`).set(auth(salesB.token));
    expect(hiddenWhileDraft.status).toBe(404);

    const finalize = await request(app).post(`/api/orders/${draftId}/finalize`).set(auth(salesA.token));
    expect(finalize.status).toBe(200);

    const visibleAfterFinalize = await request(app).get(`/api/orders/${draftId}`).set(auth(salesB.token));
    expect(visibleAfterFinalize.status).toBe(200);

    const listAll = await request(app).get("/api/orders").set(auth(salesB.token));
    expect(listAll.body.find((o: any) => o.id === draftId)).toBeTruthy();
  });
});
