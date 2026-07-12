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
let locationId: string;

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
  const sku = await prisma.sku.create({ data: { code: "PERM-SKU-1", name: "Perm Test Widget", unit: "pc" } });
  skuId = sku.id;
  const loc = await prisma.location.create({ data: { code: "P-01-01", zone: "P", rack: "01", bin: "01" } });
  locationId = loc.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("scan-sku accepts a bare code from manual entry, not just the full encoded label", () => {
  it("rejects a bare code with no SKU: prefix under the OLD strict behavior would 409 — verify the fix accepts it", async () => {
    // Set up: putaway stock, create + finalize an order, get to a
    // SKU_CONFIRMED-eligible pick item.
    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId, locationId, quantity: 10 });
    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Perm Buyer", lines: [{ skuId, qtyRequested: 5 }] });
    await request(app).post(`/api/orders/${order.body.id}/finalize`).set(auth(sales.token));
    const pickList = await request(app).get(`/api/picking/orders/${order.body.id}`).set(auth(warehouse.token));
    const item = pickList.body[0];

    await request(app).post(`/api/picking/items/${item.id}/scan-location`).set(auth(warehouse.token)).send({ locationCode: item.location.code });

    // Bare code, no "SKU:...|BATCH:...|DATE:..." wrapper — this is what a
    // human typing into the manual-entry fallback actually sends.
    const res = await request(app).post(`/api/picking/items/${item.id}/scan-sku`).set(auth(warehouse.token)).send({ label: item.sku.code });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SKU_CONFIRMED");
  });
});

describe("task-scoped visibility: Warehouse cannot browse general stock/location data", () => {
  it("blocks GET /stock, /stock/sku/:id/locations, /stock/low-stock, /stock/movements for Warehouse", async () => {
    const endpoints = [`/api/stock`, `/api/stock/sku/${skuId}/locations`, `/api/stock/low-stock`, `/api/stock/movements`];
    for (const path of endpoints) {
      const res = await request(app).get(path).set(auth(warehouse.token));
      expect(res.status).toBe(403);
    }
  });

  it("blocks GET /locations (bulk list) for Warehouse but allows the standalone by-code lookup", async () => {
    const listRes = await request(app).get("/api/locations").set(auth(warehouse.token));
    expect(listRes.status).toBe(403);

    const lookupRes = await request(app).get(`/api/locations/by-code/${locationId ? "P-01-01" : ""}`).set(auth(warehouse.token));
    expect(lookupRes.status).toBe(200);
    expect(lookupRes.body.code).toBe("P-01-01");
  });

  it("blocks GET /reports/stock-on-hand for Warehouse", async () => {
    const res = await request(app).get("/api/reports/stock-on-hand").set(auth(warehouse.token));
    expect(res.status).toBe(403);
  });

  it("still allows Sales full, non-task-scoped visibility on all of the above", async () => {
    const endpoints = [
      "/api/stock",
      `/api/stock/sku/${skuId}/locations`,
      "/api/stock/low-stock",
      "/api/stock/movements",
      "/api/locations",
      "/api/reports/stock-on-hand",
    ];
    for (const path of endpoints) {
      const res = await request(app).get(path).set(auth(sales.token));
      expect(res.status).toBe(200);
    }
  });
});

describe("composable scan permission: Accountant loses putaway/transfer, Sales can be granted it", () => {
  it("Accountant is now blocked from putaway and transfer (previously allowed)", async () => {
    const putawayRes = await request(app).post("/api/stock/putaway").set(auth(accountant.token)).send({ skuId, locationId, quantity: 1 });
    expect(putawayRes.status).toBe(403);

    const transferRes = await request(app)
      .post("/api/stock/transfer")
      .set(auth(accountant.token))
      .send({ skuId, fromLocationId: locationId, toLocationId: locationId, quantity: 1 });
    expect(transferRes.status).toBe(403);
  });

  it("Accountant can still log a new batch (purchase/production entry is a separate permission)", async () => {
    const res = await request(app).post("/api/stock/batches").set(auth(accountant.token)).send({ skuId, sourceType: "PURCHASE" });
    expect(res.status).toBe(201);
  });

  it("Sales is blocked from putaway/pick by default", async () => {
    const res = await request(app).post("/api/stock/putaway").set(auth(sales.token)).send({ skuId, locationId, quantity: 1 });
    expect(res.status).toBe(403);
  });

  it("non-Owner cannot grant the scan permission", async () => {
    const res = await request(app).patch(`/api/users/${sales.user.id}`).set(auth(accountant.token)).send({ canScanPutaway: true });
    expect(res.status).toBe(403);
  });

  it("Owner grants Sales the scan permission, it takes effect immediately, and is audited", async () => {
    const grantRes = await request(app).patch(`/api/users/${sales.user.id}`).set(auth(owner.token)).send({ canScanPutaway: true });
    expect(grantRes.status).toBe(200);
    expect(grantRes.body.canScanPutaway).toBe(true);

    // Same JWT as before — permission check is DB-backed, not baked into the
    // token, so this takes effect without the user needing to re-login.
    const putawayRes = await request(app).post("/api/stock/putaway").set(auth(sales.token)).send({ skuId, locationId, quantity: 2 });
    expect(putawayRes.status).toBe(201);

    const audit = await request(app).get("/api/reports/audit-log?entityType=User").set(auth(owner.token));
    const grantEntry = audit.body.find((a: any) => a.action === "GRANT_SCAN_ACCESS" && a.entityId === sales.user.id);
    expect(grantEntry).toBeTruthy();
    expect(grantEntry.user.id).toBe(owner.user.id);
  });

  it("granted Sales user does NOT inherit Warehouse's task-scoped visibility restriction", async () => {
    const res = await request(app).get("/api/stock").set(auth(sales.token));
    expect(res.status).toBe(200);
  });

  it("Owner revokes the permission and it takes effect immediately, and is audited", async () => {
    const revokeRes = await request(app).patch(`/api/users/${sales.user.id}`).set(auth(owner.token)).send({ canScanPutaway: false });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.canScanPutaway).toBe(false);

    const putawayRes = await request(app).post("/api/stock/putaway").set(auth(sales.token)).send({ skuId, locationId, quantity: 1 });
    expect(putawayRes.status).toBe(403);

    const audit = await request(app).get("/api/reports/audit-log?entityType=User").set(auth(owner.token));
    const revokeEntry = audit.body.find((a: any) => a.action === "REVOKE_SCAN_ACCESS" && a.entityId === sales.user.id);
    expect(revokeEntry).toBeTruthy();
  });
});
