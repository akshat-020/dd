import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let accountant: Awaited<ReturnType<typeof createUser>>;
let sales: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;

let skuId: string;
let locationA: string;
let locationB: string;

beforeAll(async () => {
  [owner, accountant, sales, warehouse] = await Promise.all([
    createUser("OWNER"),
    createUser("ACCOUNTANT"),
    createUser("SALES"),
    createUser("WAREHOUSE"),
  ]);

  const sku = await prisma.sku.create({ data: { code: "TEST-SKU-1", name: "Test Widget", unit: "pc", reorderThreshold: 5 } });
  skuId = sku.id;
  const locA = await prisma.location.create({ data: { code: "T-01-01", zone: "T", rack: "01", bin: "01" } });
  const locB = await prisma.location.create({ data: { code: "T-01-02", zone: "T", rack: "01", bin: "02" } });
  locationA = locA.id;
  locationB = locB.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("auth", () => {
  it("rejects requests without a token", async () => {
    const res = await request(app).get("/api/skus");
    expect(res.status).toBe(401);
  });

  it("logs in with valid credentials via the real login route", async () => {
    const email = "login-test@test.local";
    const bcrypt = await import("bcryptjs");
    await prisma.user.create({
      data: { name: "Login Test", email, passwordHash: await bcrypt.hash("secret123", 4), role: "OWNER" },
    });
    const res = await request(app).post("/api/auth/login").send({ email, password: "secret123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe("OWNER");
  });

  it("rejects invalid credentials", async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "nobody@test.local", password: "wrong" });
    expect(res.status).toBe(401);
  });
});

describe("stock ledger", () => {
  it("putaway increases stock at a location", async () => {
    const res = await request(app)
      .post("/api/stock/putaway")
      .set(auth(warehouse.token))
      .send({ skuId, locationId: locationA, quantity: 100 });
    expect(res.status).toBe(201);
    expect(res.body.stockItem.quantity).toBe(100);
  });

  it("rejects a transfer larger than available stock", async () => {
    const res = await request(app)
      .post("/api/stock/transfer")
      .set(auth(warehouse.token))
      .send({ skuId, fromLocationId: locationA, toLocationId: locationB, quantity: 10000 });
    expect(res.status).toBe(409);
  });

  it("allows a valid transfer and records both ledger legs", async () => {
    const res = await request(app)
      .post("/api/stock/transfer")
      .set(auth(warehouse.token))
      .send({ skuId, fromLocationId: locationA, toLocationId: locationB, quantity: 20 });
    expect(res.status).toBe(201);
    expect(res.body.out.stockItem.quantity).toBe(80);
    expect(res.body.inn.stockItem.quantity).toBe(20);
  });

  it("blocks SALES from performing putaway (not an owner/accountant/warehouse action)", async () => {
    const res = await request(app).post("/api/stock/putaway").set(auth(sales.token)).send({ skuId, locationId: locationA, quantity: 5 });
    expect(res.status).toBe(403);
  });
});

describe("order -> finalize -> pick -> invoice flow", () => {
  let orderId: string;
  let lineId: string;

  it("SALES can create a draft order", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Acme Buyer", lines: [{ skuId, qtyRequested: 50 }] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    orderId = res.body.id;
    lineId = res.body.lines[0].id;
  });

  it("WAREHOUSE cannot create orders", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(auth(warehouse.token))
      .send({ buyerName: "X", lines: [{ skuId, qtyRequested: 1 }] });
    expect(res.status).toBe(403);
  });

  it("live stock check reflects real availability", async () => {
    const res = await request(app).get(`/api/orders/${orderId}/stock-check`).set(auth(sales.token));
    expect(res.status).toBe(200);
    expect(res.body[0].available).toBe(100); // 80 at locationA + 20 at locationB
    expect(res.body[0].sufficient).toBe(true);
  });

  it("order finalize fails cleanly when stock is insufficient", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Overorder Buyer", lines: [{ skuId, qtyRequested: 99999 }] });
    const overorderId = res.body.id;
    const finalizeRes = await request(app).post(`/api/orders/${overorderId}/finalize`).set(auth(sales.token));
    expect(finalizeRes.status).toBe(409);
    const orderAfter = await prisma.order.findUnique({ where: { id: overorderId } });
    expect(orderAfter?.status).toBe("DRAFT");

    // Clean up rather than leaving this draft around: since a DRAFT order's
    // requested qty now counts as "committed" for every other order's
    // availability check (see bugfixes.test.ts), a stray 99999-qty draft
    // would otherwise starve every later test on this SKU.
    await request(app).post(`/api/orders/${overorderId}/cancel`).set(auth(owner.token));
  });

  it("finalize allocates stock and generates a pick list grouped by location", async () => {
    const res = await request(app).post(`/api/orders/${orderId}/finalize`).set(auth(sales.token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FINALIZED");

    const pickRes = await request(app).get(`/api/picking/orders/${orderId}`).set(auth(warehouse.token));
    expect(pickRes.status).toBe(200);
    const totalToPick = pickRes.body.reduce((sum: number, i: any) => sum + i.qtyToPick, 0);
    expect(totalToPick).toBe(50);
  });

  it("picker must scan location and SKU before confirming quantity (catches wrong-item picks)", async () => {
    const pickRes = await request(app).get(`/api/picking/orders/${orderId}`).set(auth(warehouse.token));
    const item = pickRes.body[0];

    const earlyConfirm = await request(app).post(`/api/picking/items/${item.id}/confirm`).set(auth(warehouse.token)).send({ quantity: item.qtyToPick });
    expect(earlyConfirm.status).toBe(409);

    const wrongLocation = await request(app)
      .post(`/api/picking/items/${item.id}/scan-location`)
      .set(auth(warehouse.token))
      .send({ locationCode: "NOT-A-REAL-CODE" });
    expect(wrongLocation.status).toBe(409);

    const rightLocation = await request(app)
      .post(`/api/picking/items/${item.id}/scan-location`)
      .set(auth(warehouse.token))
      .send({ locationCode: item.location.code });
    expect(rightLocation.status).toBe(200);

    const wrongSku = await request(app)
      .post(`/api/picking/items/${item.id}/scan-sku`)
      .set(auth(warehouse.token))
      .send({ label: "SKU:SOME-OTHER-SKU|BATCH:B1|DATE:2026-01-01" });
    expect(wrongSku.status).toBe(409);

    const rightSku = await request(app)
      .post(`/api/picking/items/${item.id}/scan-sku`)
      .set(auth(warehouse.token))
      .send({ label: `SKU:${item.sku.code}|BATCH:B1|DATE:2026-01-01` });
    expect(rightSku.status).toBe(200);

    const confirm = await request(app).post(`/api/picking/items/${item.id}/confirm`).set(auth(warehouse.token)).send({ quantity: item.qtyToPick });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("PICKED");
  });

  it("order moves to LOADED once every pick item is confirmed, and stock is deducted", async () => {
    const order = await request(app).get(`/api/orders/${orderId}`).set(auth(owner.token));
    expect(order.body.status).toBe("LOADED");

    const stock = await request(app).get(`/api/stock/sku/${skuId}/locations`).set(auth(owner.token));
    const total = stock.body.reduce((sum: number, i: any) => sum + i.quantity, 0);
    expect(total).toBe(50); // 100 putaway - 50 picked
  });

  it("SALES and WAREHOUSE never see price fields on the order", async () => {
    const asSales = await request(app).get(`/api/orders/${orderId}`).set(auth(sales.token));
    const asWarehouse = await request(app).get(`/api/orders/${orderId}`).set(auth(warehouse.token));
    for (const res of [asSales, asWarehouse]) {
      for (const line of res.body.lines) {
        expect(line).not.toHaveProperty("unitPrice");
        expect(line).not.toHaveProperty("price");
      }
    }
  });

  it("SALES and WAREHOUSE are forbidden from the pricing endpoints entirely", async () => {
    const getRes = await request(app).get(`/api/orders/${orderId}/pricing`).set(auth(sales.token));
    expect(getRes.status).toBe(403);
    const putRes = await request(app).put(`/api/orders/${orderId}/pricing`).set(auth(warehouse.token)).send({ lines: [{ lineId, unitPrice: 999 }] });
    expect(putRes.status).toBe(403);
  });

  it("ACCOUNTANT can set and read pricing, and it then appears for OWNER too", async () => {
    const setRes = await request(app)
      .put(`/api/orders/${orderId}/pricing`)
      .set(auth(accountant.token))
      .send({ lines: [{ lineId, unitPrice: 250 }] });
    expect(setRes.status).toBe(200);
    expect(setRes.body.lines[0].unitPrice).toBe(250);

    const ownerView = await request(app).get(`/api/orders/${orderId}`).set(auth(owner.token));
    expect(ownerView.body.lines[0].unitPrice).toBe(250);
  });

  let invoiceRefId: string;

  it("ACCOUNTANT can add an Invoice Reference, moving the order to INVOICED", async () => {
    const res = await request(app)
      .post("/api/invoice-references")
      .set(auth(accountant.token))
      .send({ tallyInvoiceNumber: "TALLY-0001", orderId, lines: [{ skuId, qty: 50, price: 250 }] });
    expect(res.status).toBe(201);
    invoiceRefId = res.body.id;

    const order = await request(app).get(`/api/orders/${orderId}`).set(auth(owner.token));
    expect(order.body.status).toBe("INVOICED");
  });

  it("WAREHOUSE cannot access invoice references", async () => {
    const res = await request(app).get(`/api/invoice-references/${invoiceRefId}`).set(auth(warehouse.token));
    expect(res.status).toBe(403);
  });

  it("cancelling an Invoice Reference with reverseStock restores stock to the original location", async () => {
    const before = await request(app).get(`/api/stock/sku/${skuId}/locations`).set(auth(owner.token));
    const beforeTotal = before.body.reduce((s: number, i: any) => s + i.quantity, 0);

    const res = await request(app).post(`/api/invoice-references/${invoiceRefId}/cancel`).set(auth(accountant.token)).send({ reverseStock: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");

    const after = await request(app).get(`/api/stock/sku/${skuId}/locations`).set(auth(owner.token));
    const afterTotal = after.body.reduce((s: number, i: any) => s + i.quantity, 0);
    expect(afterTotal).toBe(beforeTotal + 50);
  });
});

describe("location QR generation", () => {
  it("returns a PNG image for a location QR code", async () => {
    const res = await request(app).get(`/api/locations/${locationA}/qr`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
  });
});
