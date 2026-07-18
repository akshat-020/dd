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

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  [owner, accountant, sales, warehouse] = await Promise.all([
    createUser("OWNER"),
    createUser("ACCOUNTANT"),
    createUser("SALES"),
    createUser("WAREHOUSE"),
  ]);
  const sku = await prisma.sku.create({ data: { code: "INWARD-SKU-1", name: "Inward Test Widget", unit: "pc" } });
  skuId = sku.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("inward entry logging: Owner + Sales(default true), never Accountant/Warehouse", () => {
  it("Sales can log an inward entry by default (canLogInwardEntry defaults true)", async () => {
    const res = await request(app)
      .post("/api/stock/batches")
      .set(auth(sales.token))
      .send({ skuId, sourceType: "PURCHASE", receivedQuantity: 50, supplierRef: "PO-1" });
    expect(res.status).toBe(201);
    expect(res.body.receivedQuantity).toBe(50);
    expect(res.body.supplierRef).toBe("PO-1");
  });

  it("Owner can always log an inward entry", async () => {
    const res = await request(app)
      .post("/api/stock/batches")
      .set(auth(owner.token))
      .send({ skuId, sourceType: "PRODUCTION", receivedQuantity: 20 });
    expect(res.status).toBe(201);
  });

  it("Accountant is blocked from logging an inward entry", async () => {
    const res = await request(app)
      .post("/api/stock/batches")
      .set(auth(accountant.token))
      .send({ skuId, sourceType: "PURCHASE", receivedQuantity: 10 });
    expect(res.status).toBe(403);
  });

  it("Warehouse is blocked from logging an inward entry", async () => {
    const res = await request(app)
      .post("/api/stock/batches")
      .set(auth(warehouse.token))
      .send({ skuId, sourceType: "PURCHASE", receivedQuantity: 10 });
    expect(res.status).toBe(403);
  });

  it("receivedQuantity is required", async () => {
    const res = await request(app).post("/api/stock/batches").set(auth(owner.token)).send({ skuId, sourceType: "PURCHASE" });
    expect(res.status).toBe(400);
  });

  it("Owner can revoke Sales' inward-entry access, it takes effect immediately, and is audited", async () => {
    const revokeRes = await request(app).delete(`/api/users/${sales.user.id}/permissions/inventory.logInwardEntry`).set(auth(owner.token));
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.permissions).not.toContain("inventory.logInwardEntry");

    const blockedRes = await request(app)
      .post("/api/stock/batches")
      .set(auth(sales.token))
      .send({ skuId, sourceType: "PURCHASE", receivedQuantity: 5 });
    expect(blockedRes.status).toBe(403);

    const audit = await request(app).get("/api/reports/audit-log?entityType=User").set(auth(owner.token));
    const revokeEntry = audit.body.find((a: any) => a.action === "REVOKE_PERMISSION" && a.entityId === sales.user.id);
    expect(revokeEntry).toBeTruthy();

    // restore for subsequent tests
    await request(app).put(`/api/users/${sales.user.id}/permissions/inventory.logInwardEntry`).set(auth(owner.token));
  });

  it("non-Owner cannot grant/revoke inward-entry access", async () => {
    const res = await request(app).delete(`/api/users/${sales.user.id}/permissions/inventory.logInwardEntry`).set(auth(accountant.token));
    expect(res.status).toBe(403);
  });
});

describe("GET /stock/batches/recent — available to inward or scan access, not to Accountant", () => {
  it("Owner, Sales (inward), and Warehouse (scan) can list recent batches", async () => {
    for (const token of [owner.token, sales.token, warehouse.token]) {
      const res = await request(app).get("/api/stock/batches/recent").set(auth(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    }
  });

  it("Accountant (neither inward nor scan access) is blocked", async () => {
    const res = await request(app).get("/api/stock/batches/recent").set(auth(accountant.token));
    expect(res.status).toBe(403);
  });
});

describe("purchase cost references: Owner + Accountant only", () => {
  let batchId: string;

  beforeAll(async () => {
    const batch = await request(app)
      .post("/api/stock/batches")
      .set(auth(owner.token))
      .send({ skuId, sourceType: "PURCHASE", receivedQuantity: 100, supplierRef: "PO-COST-1" });
    batchId = batch.body.id;
  });

  it("Accountant can add a cost reference", async () => {
    const res = await request(app)
      .post(`/api/stock/batches/${batchId}/cost-references`)
      .set(auth(accountant.token))
      .send({ quantity: 100, unitCost: 12.5, supplierRef: "PO-COST-1" });
    expect(res.status).toBe(201);
    expect(res.body.unitCost).toBe(12.5);
  });

  it("Owner can view cost references for the batch", async () => {
    const res = await request(app).get(`/api/stock/batches/${batchId}/cost-references`).set(auth(owner.token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("Sales and Warehouse are forbidden from cost references entirely", async () => {
    const postRes = await request(app)
      .post(`/api/stock/batches/${batchId}/cost-references`)
      .set(auth(sales.token))
      .send({ quantity: 1, unitCost: 1 });
    expect(postRes.status).toBe(403);

    const getRes = await request(app).get(`/api/stock/batches/${batchId}/cost-references`).set(auth(warehouse.token));
    expect(getRes.status).toBe(403);
  });
});
