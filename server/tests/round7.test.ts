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

async function scanAndConfirm(itemId: string, item: any, quantity: number) {
  await request(app).post(`/api/picking/items/${itemId}/scan-location`).set(auth(warehouse.token)).send({ locationCode: item.location.code });
  await request(app).post(`/api/picking/items/${itemId}/scan-sku`).set(auth(warehouse.token)).send({ label: item.sku.code });
  return request(app).post(`/api/picking/items/${itemId}/confirm`).set(auth(warehouse.token)).send({ quantity });
}

describe("#1 order-level audit trail", () => {
  it("shows chronological events with role-safe redaction for Sales, full detail for Owner/Accountant", async () => {
    const sku = await prisma.sku.create({ data: { code: "R7-SKU-1", name: "Round7 Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R7-LOC-1", zone: "R7", rack: "01" } });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 50 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round7 Buyer", lines: [{ skuId: sku.id, qtyRequested: 10 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    await scanAndConfirm(item.id, item, 10);

    const price = await request(app).put(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token)).send({
      lines: [{ lineId: order.body.lines[0].id, unitPrice: 99.5 }],
    });
    expect(price.status).toBe(200);
    await request(app)
      .post("/api/invoice-references")
      .set(auth(accountant.token))
      .send({ tallyInvoiceNumber: `R7-INV-${Date.now()}`, orderId: order.body.id, lines: [{ skuId: sku.id, qty: 10, price: 99.5 }] });

    const salesView = await request(app).get(`/api/orders/${order.body.id}/audit`).set(auth(sales.token));
    expect(salesView.status).toBe(200);
    expect(salesView.body.length).toBeGreaterThanOrEqual(3); // create, finalize, pick, invoice
    for (const entry of salesView.body) {
      expect(entry).not.toHaveProperty("before");
      expect(entry).not.toHaveProperty("after");
      expect(JSON.stringify(entry)).not.toMatch(/99\.5/);
    }
    expect(salesView.body.some((e: any) => e.summary === "Order created")).toBe(true);
    expect(salesView.body.some((e: any) => e.summary === "Item picked")).toBe(true);
    expect(salesView.body.some((e: any) => e.summary === "Invoice reference logged")).toBe(true);

    const ownerView = await request(app).get(`/api/orders/${order.body.id}/audit`).set(auth(owner.token));
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.every((e: any) => "before" in e && "after" in e)).toBe(true);
    // Chronological order.
    const timestamps = ownerView.body.map((e: any) => new Date(e.createdAt).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });
});

describe("#2 order book default filtering", () => {
  it("hides old, concluded orders by default but keeps old-but-still-active ones, and search bypasses the filter", async () => {
    const sku = await prisma.sku.create({ data: { code: "R7-SKU-2", name: "Round7 Filter Widget", unit: "pc" } });

    const oldInvoiced = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round7 Old Invoiced", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    await prisma.order.update({ where: { id: oldInvoiced.body.id }, data: { status: "INVOICED", createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } });

    const oldActive = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round7 Old Active", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    await prisma.order.update({ where: { id: oldActive.body.id }, data: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } }); // still DRAFT

    const recent = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round7 Recent", lines: [{ skuId: sku.id, qtyRequested: 1 }] });

    const defaultView = await request(app).get("/api/orders").set(auth(owner.token));
    const ids = defaultView.body.map((o: any) => o.id);
    expect(ids).not.toContain(oldInvoiced.body.id); // old + concluded -> hidden
    expect(ids).toContain(oldActive.body.id); // old but still active -> shown
    expect(ids).toContain(recent.body.id); // recent -> shown

    const searched = await request(app).get("/api/orders?search=Round7 Old Invoiced").set(auth(owner.token));
    expect(searched.body.some((o: any) => o.id === oldInvoiced.body.id)).toBe(true); // search bypasses the default filter
  });
});

describe("#4 post-pick adjustment (put-back)", () => {
  it("creates a put-back task when Final Qty drops below already-picked, and confirming it reconciles stock and qtyPicked", async () => {
    const sku = await prisma.sku.create({ data: { code: "R7-SKU-4", name: "Round7 Putback Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R7-LOC-4", zone: "R7", rack: "04" } });
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 100 });

    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round7 Putback Buyer", lines: [{ skuId: sku.id, qtyRequested: 20 }] });
    const lineId = order.body.lines[0].id;
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    await scanAndConfirm(item.id, item, 20);

    const stockBefore = await prisma.stockItem.findFirst({ where: { skuId: sku.id, locationId: loc.id } });

    const reduced = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ id: lineId, qtyFinalized: 12 }] });
    expect(reduced.status).toBe(200);

    const pending = await request(app).get("/api/put-backs").set(auth(warehouse.token));
    const task = pending.body.find((t: any) => t.orderLineId === lineId);
    expect(task).toBeTruthy();
    expect(task.quantity).toBe(8); // 20 picked - 12 new target
    expect(task.status).toBe("PENDING");
    expect(task.fromLocation.code).toBe(loc.code); // suggested from where it was picked

    // Order line still shows the full 20 as picked (in limbo, not silently
    // reconciled) plus the pending amount as a separate visible signal.
    const orderMidway = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    const lineMidway = orderMidway.body.lines.find((l: any) => l.id === lineId);
    expect(lineMidway.qtyPicked).toBe(20);
    expect(lineMidway.pendingPutBackQty).toBe(8);

    const confirm = await request(app).post(`/api/put-backs/${task.id}/confirm`).set(auth(warehouse.token)).send({});
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("CONFIRMED");

    const stockAfter = await prisma.stockItem.findFirst({ where: { skuId: sku.id, locationId: loc.id } });
    expect(stockAfter!.quantity - stockBefore!.quantity).toBe(8); // returned to the shelf

    const orderAfter = await request(app).get(`/api/orders/${order.body.id}`).set(auth(sales.token));
    const lineAfter = orderAfter.body.lines.find((l: any) => l.id === lineId);
    expect(lineAfter.qtyPicked).toBe(12); // reconciled down to match the new Final Qty
    expect(lineAfter.pendingPutBackQty).toBe(0);
  });

  it("increasing Final Qty back up reclaims from a pending put-back instead of allocating fresh stock", async () => {
    const sku = await prisma.sku.create({ data: { code: "R7-SKU-5", name: "Round7 Reclaim Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R7-LOC-5", zone: "R7", rack: "05" } });
    // Exactly enough stock for the original pick and nothing more, so a
    // fresh allocation for the "increase back up" would fail if reclaim
    // didn't happen first.
    await request(app).post("/api/stock/putaway").set(auth(owner.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 20 });

    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round7 Reclaim Buyer", lines: [{ skuId: sku.id, qtyRequested: 20 }] });
    const lineId = order.body.lines[0].id;
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));

    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];
    await scanAndConfirm(item.id, item, 20);

    await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ id: lineId, qtyFinalized: 12 }] });
    let pending = await request(app).get("/api/put-backs").set(auth(warehouse.token));
    expect(pending.body.find((t: any) => t.orderLineId === lineId).quantity).toBe(8);

    // Back up to 18 — should reclaim 6 of the pending 8, leaving 2 pending,
    // without needing (or failing on) any fresh shelf stock.
    const backUp = await request(app).patch(`/api/orders/${order.body.id}`).set(auth(sales.token)).send({ lines: [{ id: lineId, qtyFinalized: 18 }] });
    expect(backUp.status).toBe(200);

    pending = await request(app).get("/api/put-backs").set(auth(warehouse.token));
    const remainingTask = pending.body.find((t: any) => t.orderLineId === lineId);
    expect(remainingTask.quantity).toBe(2);
  });
});

describe("#5 Proforma Invoice", () => {
  it("creates a PI with its own numbering series, no tax breakup fields, and restricts access to Owner/Accountant", async () => {
    const sku = await prisma.sku.create({ data: { code: "R7-SKU-6", name: "Round7 PI Widget", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round7 PI Buyer", lines: [{ skuId: sku.id, qtyRequested: 5 }] });

    const forbidden = await request(app)
      .post("/api/proforma-invoices")
      .set(auth(sales.token))
      .send({ orderId: order.body.id, validUntil: new Date(Date.now() + 7 * 86400000).toISOString(), lines: [{ skuId: sku.id, qty: 5, unit: "pc", unitPrice: 100 }] });
    expect(forbidden.status).toBe(403);

    const created = await request(app)
      .post("/api/proforma-invoices")
      .set(auth(owner.token))
      .send({ orderId: order.body.id, validUntil: new Date(Date.now() + 7 * 86400000).toISOString(), lines: [{ skuId: sku.id, qty: 5, unit: "pc", unitPrice: 100 }] });
    expect(created.status).toBe(201);
    expect(created.body.piNumber).toMatch(/^PI-\d{4}-\d{4}$/);
    expect(created.body.version).toBe(1);
    expect(created.body.status).toBe("ACTIVE");
    expect(created.body.lines[0].unitPrice).toBe(100);

    const pdf = await request(app).get(`/api/proforma-invoices/${created.body.id}/pdf`).set(auth(owner.token));
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");

    // Reissue: new version, previous marked SUPERSEDED, same order.
    const reissued = await request(app)
      .post("/api/proforma-invoices")
      .set(auth(accountant.token))
      .send({ orderId: order.body.id, validUntil: new Date(Date.now() + 14 * 86400000).toISOString(), lines: [{ skuId: sku.id, qty: 3, unit: "pc", unitPrice: 100 }] });
    expect(reissued.status).toBe(201);
    expect(reissued.body.version).toBe(2);
    expect(reissued.body.piNumber).not.toBe(created.body.piNumber);

    const history = await request(app).get(`/api/proforma-invoices/order/${order.body.id}`).set(auth(owner.token));
    expect(history.body).toHaveLength(2);
    expect(history.body.find((p: any) => p.id === created.body.id).status).toBe("SUPERSEDED");
    expect(history.body.find((p: any) => p.id === reissued.body.id).status).toBe("ACTIVE");
  });
});

describe("Company settings (bank details + label print format)", () => {
  it("is Owner-writable, Owner/Accountant-readable, and rejects other roles", async () => {
    const write = await request(app)
      .put("/api/settings")
      .set(auth(owner.token))
      .send({ bankAccountName: "Acme Traders", bankAccountNumber: "1234567890", bankIfsc: "ABCD0123456", bankName: "Test Bank", labelPrintFormat: "GRID" });
    expect(write.status).toBe(200);

    const readAccountant = await request(app).get("/api/settings").set(auth(accountant.token));
    expect(readAccountant.status).toBe(200);
    expect(readAccountant.body.labelPrintFormat).toBe("GRID");

    const forbiddenWrite = await request(app).put("/api/settings").set(auth(accountant.token)).send({ labelPrintFormat: "SINGLE" });
    expect(forbiddenWrite.status).toBe(403);

    const forbiddenRead = await request(app).get("/api/settings").set(auth(sales.token));
    expect(forbiddenRead.status).toBe(403);
  });

  it("exposes just the label print format to any authenticated role (Warehouse/Sales need it to print, unlike bank details)", async () => {
    await request(app).put("/api/settings").set(auth(owner.token)).send({ labelPrintFormat: "SINGLE" });

    const warehouseRead = await request(app).get("/api/settings/label-format").set(auth(warehouse.token));
    expect(warehouseRead.status).toBe(200);
    expect(warehouseRead.body).toEqual({ labelPrintFormat: "SINGLE" });
    expect(warehouseRead.body).not.toHaveProperty("bankAccountNumber");

    const salesRead = await request(app).get("/api/settings/label-format").set(auth(sales.token));
    expect(salesRead.status).toBe(200);
    expect(salesRead.body.labelPrintFormat).toBe("SINGLE");
  });
});

describe("audit summary text for pricing updates", () => {
  it("describes a SET_PRICING entry in plain language instead of falling back to the raw action/entity name", async () => {
    const sku = await prisma.sku.create({ data: { code: "R7-SKU-PRICING", name: "Round7 Pricing Widget", unit: "pc" } });
    const order = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round7 Pricing Buyer", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    await request(app)
      .put(`/api/orders/${order.body.id}/pricing`)
      .set(auth(owner.token))
      .send({ lines: [{ lineId: order.body.lines[0].id, unitPrice: 42 }] });

    const ownerView = await request(app).get(`/api/orders/${order.body.id}/audit`).set(auth(owner.token));
    const pricingEntry = ownerView.body.find((e: any) => e.entityType === "Order" && e.action === "SET_PRICING");
    expect(pricingEntry).toBeTruthy();
    expect(pricingEntry.summary).toBe("Pricing updated");
    expect(pricingEntry.summary).not.toMatch(/SET_PRICING/);
  });
});
