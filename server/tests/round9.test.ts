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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Access Control Model — account creation applies a role template, not a fixed role gate", () => {
  it("POST /api/users seeds the new account's permissions from its role template and audit-logs it", async () => {
    const res = await request(app)
      .post("/api/users")
      .set(auth(owner.token))
      .send({ name: "New Sales Hire", email: `new-sales-${Date.now()}@test.local`, password: "correct-horse-1", role: "SALES" });
    expect(res.status).toBe(201);
    expect(res.body.permissions).toEqual(expect.arrayContaining(["orders.createDraft", "orders.editFinalized", "inventory.viewStockFull", "inventory.logInwardEntry"]));
    expect(res.body.permissions).not.toContain("masterdata.editSku"); // not part of the SALES template

    const audit = await request(app).get("/api/reports/audit-log?entityType=User").set(auth(owner.token));
    const createEntry = audit.body.find((a: any) => a.action === "CREATE" && a.entityId === res.body.id);
    expect(createEntry).toBeTruthy();
  });

  it("Owner accounts always report every catalogued permission, with no UserPermission rows written", async () => {
    const me = await request(app).get("/api/auth/me").set(auth(owner.token));
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain("admin.configureSettings");
    expect(me.body.permissions).toContain("orders.viewAllDrafts");
    const rows = await prisma.userPermission.findMany({ where: { userId: owner.user.id } });
    expect(rows).toHaveLength(0);
  });
});

describe("Access Control Model — individual grant/revoke, deny-by-default", () => {
  it("a fresh Sales account cannot view all drafts or full order history by default (deny-by-default for a permission its template doesn't include)", async () => {
    const s2 = await createUser("SALES");
    const me = await request(app).get("/api/auth/me").set(auth(s2.token));
    expect(me.body.permissions).not.toContain("orders.viewAllDrafts");
    expect(me.body.permissions).not.toContain("orders.viewFullHistory");
  });

  it("Owner grants Sales orders.viewAllDrafts individually — not by changing their role — and it's revocable independently", async () => {
    const s2 = await createUser("SALES");
    const grant = await request(app).put(`/api/users/${s2.user.id}/permissions/orders.viewAllDrafts`).set(auth(owner.token));
    expect(grant.status).toBe(200);
    expect(grant.body.permissions).toContain("orders.viewAllDrafts");
    // Everything else from their SALES template is untouched.
    expect(grant.body.permissions).toContain("orders.createDraft");

    const revoke = await request(app).delete(`/api/users/${s2.user.id}/permissions/orders.viewAllDrafts`).set(auth(owner.token));
    expect(revoke.status).toBe(200);
    expect(revoke.body.permissions).not.toContain("orders.viewAllDrafts");
    expect(revoke.body.permissions).toContain("orders.createDraft");
  });

  it("rejects an unknown permission key", async () => {
    const res = await request(app).put(`/api/users/${sales.user.id}/permissions/not.a.real.permission`).set(auth(owner.token));
    expect(res.status).toBe(400);
  });

  it("refuses to grant or revoke anything on an Owner account (Owner always has everything already)", async () => {
    const grant = await request(app).put(`/api/users/${owner.user.id}/permissions/orders.viewAllDrafts`).set(auth(owner.token));
    expect(grant.status).toBe(400);
    const revoke = await request(app).delete(`/api/users/${owner.user.id}/permissions/admin.configureSettings`).set(auth(owner.token));
    expect(revoke.status).toBe(400);
  });

  it("non-Owner cannot grant or revoke any permission, for any account", async () => {
    const res = await request(app).put(`/api/users/${sales.user.id}/permissions/masterdata.editSku`).set(auth(accountant.token));
    expect(res.status).toBe(403);
  });
});

describe("Access Control Model — orders.viewFullHistory is a hard ceiling, not just a default", () => {
  it("an explicit search/date filter still can't reach an old, concluded order without the permission — but can once granted", async () => {
    const sku = await prisma.sku.create({ data: { code: "R9-HIST-SKU", name: "Round9 History Widget", unit: "pc" } });
    const oldOrder = await request(app).post("/api/orders").set(auth(sales.token)).send({ buyerName: "Round9 Old Concluded", lines: [{ skuId: sku.id, qtyRequested: 1 }] });
    await prisma.order.update({
      where: { id: oldOrder.body.id },
      data: { status: "INVOICED", createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    // Sales lacks orders.viewFullHistory by default — an explicit search for
    // this exact order still shouldn't surface it.
    const searched = await request(app).get("/api/orders?search=Round9 Old Concluded").set(auth(sales.token));
    expect(searched.status).toBe(200);
    expect(searched.body.some((o: any) => o.id === oldOrder.body.id)).toBe(false);

    await request(app).put(`/api/users/${sales.user.id}/permissions/orders.viewFullHistory`).set(auth(owner.token));
    const searchedAfterGrant = await request(app).get("/api/orders?search=Round9 Old Concluded").set(auth(sales.token));
    expect(searchedAfterGrant.body.some((o: any) => o.id === oldOrder.body.id)).toBe(true);

    await request(app).delete(`/api/users/${sales.user.id}/permissions/orders.viewFullHistory`).set(auth(owner.token));
  });
});

describe("Default Price (MRP) — field-level protection, independent of general SKU edit access", () => {
  it("Owner (has pricing.setDefaultPrice) can set defaultPrice/defaultAltUnitPrice on create, and it round-trips decrypted", async () => {
    const res = await request(app)
      .post("/api/skus")
      .set(auth(owner.token))
      .send({ code: "R9-MRP-1", name: "Round9 MRP Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 12, defaultPrice: 15, defaultAltUnitPrice: 170 });
    expect(res.status).toBe(201);
    expect(res.body.defaultPrice).toBe(15);
    expect(res.body.defaultAltUnitPrice).toBe(170);

    const raw = await prisma.sku.findUnique({ where: { id: res.body.id } });
    expect(raw!.defaultPrice).not.toBe("15"); // stored encrypted, not plaintext
    expect(raw!.defaultPrice).not.toBeNull();
  });

  it("Warehouse (masterdata.editSku but no pricing.setDefaultPrice) can create/edit a SKU, but any defaultPrice in the request is silently dropped, not an error", async () => {
    const res = await request(app)
      .post("/api/skus")
      .set(auth(warehouse.token))
      .send({ code: "R9-MRP-2", name: "Round9 No-Price Widget", unit: "pc", defaultPrice: 999 });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("defaultPrice"); // Warehouse can't see it either

    const raw = await prisma.sku.findUnique({ where: { id: res.body.id } });
    expect(raw!.defaultPrice).toBeNull(); // silently dropped, never persisted

    const patch = await request(app).patch(`/api/skus/${res.body.id}`).set(auth(warehouse.token)).send({ defaultPrice: 500, category: "Updated Cat" });
    expect(patch.status).toBe(200);
    const rawAfter = await prisma.sku.findUnique({ where: { id: res.body.id } });
    expect(rawAfter!.defaultPrice).toBeNull();
    expect(rawAfter!.category).toBe("Updated Cat"); // the rest of the edit still applied
  });

  it("GET /skus and GET /skus/:id omit defaultPrice entirely for a viewer without pricing.viewSalePrice or pricing.setDefaultPrice", async () => {
    const sku = await prisma.sku.create({ data: { code: "R9-MRP-3", name: "Round9 Hidden Price Widget", unit: "pc" } });
    await request(app).patch(`/api/skus/${sku.id}`).set(auth(owner.token)).send({ defaultPrice: 42 });

    const warehouseList = await request(app).get("/api/skus").set(auth(warehouse.token));
    const found = warehouseList.body.find((s: any) => s.id === sku.id);
    expect(found).toBeTruthy();
    expect(found).not.toHaveProperty("defaultPrice");

    const warehouseSingle = await request(app).get(`/api/skus/${sku.id}`).set(auth(warehouse.token));
    expect(warehouseSingle.body).not.toHaveProperty("defaultPrice");

    const accountantSingle = await request(app).get(`/api/skus/${sku.id}`).set(auth(accountant.token));
    expect(accountantSingle.body.defaultPrice).toBe(42); // Accountant has pricing.viewSalePrice
  });

  it("GET /orders/:id/pricing prefills defaultUnitPrice matching the line's actual unit (base vs alt), and it's non-retroactive once a real price is set", async () => {
    const sku = await prisma.sku.create({ data: { code: "R9-MRP-4", name: "Round9 Prefill Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 } });
    await request(app).patch(`/api/skus/${sku.id}`).set(auth(owner.token)).send({ defaultPrice: 5, defaultAltUnitPrice: 45 });

    const order = await request(app)
      .post("/api/orders")
      .set(auth(sales.token))
      .send({ buyerName: "Round9 Prefill Buyer", lines: [{ skuId: sku.id, qtyRequested: 2, unit: "Box" }] });
    const lineId = order.body.lines[0].id;

    const pricingBefore = await request(app).get(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token));
    expect(pricingBefore.body.lines[0].unit).toBe("Box");
    expect(pricingBefore.body.lines[0].defaultUnitPrice).toBe(45); // alt-unit default, not base
    expect(pricingBefore.body.lines[0].unitPrice).toBeNull(); // nothing explicitly set yet

    // Explicitly set a real price, then change the SKU's default afterward —
    // the already-set line price must not move.
    await request(app).put(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token)).send({ lines: [{ lineId, unitPrice: 99 }] });
    await request(app).patch(`/api/skus/${sku.id}`).set(auth(owner.token)).send({ defaultAltUnitPrice: 500 });

    const pricingAfter = await request(app).get(`/api/orders/${order.body.id}/pricing`).set(auth(owner.token));
    expect(pricingAfter.body.lines[0].unitPrice).toBe(99); // untouched by the later default-price change
    expect(pricingAfter.body.lines[0].defaultUnitPrice).toBe(500); // the hint itself does update, for any *new* line
  });
});
