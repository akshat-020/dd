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

describe("Bulk SKU import — template + access", () => {
  it("serves a CSV template to the same roles allowed to edit SKUs, and blocks Sales", async () => {
    const ownerRes = await request(app).get("/api/skus/bulk/template").set(auth(owner.token));
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.headers["content-type"]).toMatch(/text\/csv/);
    expect(ownerRes.text.split("\n")[0]).toBe("code,name,category,unit,altUnitName,altUnitFactor,reorderThreshold");

    const warehouseRes = await request(app).get("/api/skus/bulk/template").set(auth(warehouse.token));
    expect(warehouseRes.status).toBe(200);

    const salesRes = await request(app).get("/api/skus/bulk/template").set(auth(sales.token));
    expect(salesRes.status).toBe(403);
  });
});

describe("Bulk SKU import — preview", () => {
  it("classifies new codes as create, existing codes as update, and flags in-file duplicates / missing fields as errors", async () => {
    const existing = await prisma.sku.create({ data: { code: "R8-EXIST", name: "Old Name", unit: "pc", category: "Old Cat" } });

    const res = await request(app)
      .post("/api/skus/bulk/preview")
      .set(auth(owner.token))
      .send({
        rows: [
          { code: "R8-NEW-1", name: "Brand New Widget", unit: "pc", category: "Widgets" },
          { code: "R8-EXIST", name: "New Name", unit: "pc", category: "New Cat" },
          { code: "", name: "No code here", unit: "pc" },
          { code: "R8-DUPE", name: "First dupe", unit: "pc" },
          { code: "R8-DUPE", name: "Second dupe", unit: "pc" },
          { code: "R8-MISSING-NAME", name: "", unit: "pc" },
        ],
      });

    expect(res.status).toBe(200);
    const rows = res.body.rows;
    expect(rows[0]).toMatchObject({ rowNumber: 1, code: "R8-NEW-1", action: "create", errors: [] });
    expect(rows[1]).toMatchObject({ rowNumber: 2, code: "R8-EXIST", action: "update" });
    expect(rows[1].changes).toHaveProperty("name");
    expect(rows[1].changes).toHaveProperty("category");
    expect(rows[2]).toMatchObject({ rowNumber: 3, action: "error" });
    expect(rows[2].errors).toContain("Missing SKU code");
    expect(rows[3].errors).toContain("Duplicate SKU code within file");
    expect(rows[4].errors).toContain("Duplicate SKU code within file");
    expect(rows[5].errors).toContain("Missing SKU name");

    // 4 error rows: missing code, both duplicate-code rows, and missing name.
    expect(res.body.summary).toMatchObject({ toCreate: 1, toUpdate: 1, errors: 4 });

    // Preview must not have written anything.
    const stillOld = await prisma.sku.findUnique({ where: { id: existing.id } });
    expect(stillOld!.name).toBe("Old Name");
    const shouldNotExist = await prisma.sku.findUnique({ where: { code: "R8-NEW-1" } });
    expect(shouldNotExist).toBeNull();
  });

  it("treats blank optional cells on an update row as 'leave unchanged', not as clearing the field", async () => {
    await prisma.sku.create({
      data: { code: "R8-KEEP", name: "Keep Me", unit: "pc", category: "Kept Category", altUnitName: "Box", altUnitFactor: 12 },
    });

    const res = await request(app)
      .post("/api/skus/bulk/preview")
      .set(auth(owner.token))
      .send({ rows: [{ code: "R8-KEEP", name: "Keep Me", unit: "pc" }] }); // category/altUnit* left blank

    expect(res.status).toBe(200);
    expect(res.body.rows[0].action).toBe("update");
    expect(res.body.rows[0].changes ?? {}).not.toHaveProperty("category");
    expect(res.body.rows[0].changes ?? {}).not.toHaveProperty("altUnitFactor");
  });

  it("flags a conversion-factor change on a SKU with existing stock as requiring confirmation, without applying it", async () => {
    const sku = await prisma.sku.create({ data: { code: "R8-FACTOR", name: "Factor Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 } });
    const loc = await prisma.location.create({ data: { code: "R8-LOC", zone: "R8", rack: "01" } });
    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 5 });

    const res = await request(app)
      .post("/api/skus/bulk/preview")
      .set(auth(owner.token))
      .send({ rows: [{ code: "R8-FACTOR", name: "Factor Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 20 }] });

    expect(res.status).toBe(200);
    expect(res.body.rows[0].requiresConfirmation).toBe(true);
    expect(res.body.rows[0].confirmationMessage).toMatch(/only applies going forward/);
    expect(res.body.summary.needsConfirmation).toBe(1);

    const unchanged = await prisma.sku.findUnique({ where: { id: sku.id } });
    expect(unchanged!.altUnitFactor).toBe(10);
  });
});

describe("Bulk SKU import — commit", () => {
  it("creates new rows and updates existing ones in one pass, skips error rows, and is Sales-forbidden", async () => {
    const existing = await prisma.sku.create({ data: { code: "R8-COMMIT-EXIST", name: "Before", unit: "pc" } });

    const forbidden = await request(app)
      .post("/api/skus/bulk/commit")
      .set(auth(sales.token))
      .send({ rows: [{ code: "R8-X", name: "X", unit: "pc" }] });
    expect(forbidden.status).toBe(403);

    const res = await request(app)
      .post("/api/skus/bulk/commit")
      .set(auth(owner.token))
      .send({
        rows: [
          { code: "R8-COMMIT-NEW", name: "Brand New", unit: "pc", category: "New", reorderThreshold: 5 },
          { code: "R8-COMMIT-EXIST", name: "After", unit: "pc" },
          { code: "", name: "Bad row", unit: "pc" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.updated).toBe(1);
    expect(res.body.skipped).toBe(1);

    const created = await prisma.sku.findUnique({ where: { code: "R8-COMMIT-NEW" } });
    expect(created).toMatchObject({ name: "Brand New", category: "New", reorderThreshold: 5 });

    const updated = await prisma.sku.findUnique({ where: { id: existing.id } });
    expect(updated!.name).toBe("After");
  });

  it("only applies a conversion-factor change once confirmFactorChange is set on that row, and audit-logs the update", async () => {
    const sku = await prisma.sku.create({ data: { code: "R8-COMMIT-FACTOR", name: "Factor Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 10 } });
    const loc = await prisma.location.create({ data: { code: "R8-COMMIT-LOC", zone: "R8", rack: "02" } });
    await request(app).post("/api/stock/putaway").set(auth(warehouse.token)).send({ skuId: sku.id, locationId: loc.id, quantity: 5 });

    const withoutConfirm = await request(app)
      .post("/api/skus/bulk/commit")
      .set(auth(owner.token))
      .send({ rows: [{ code: "R8-COMMIT-FACTOR", name: "Factor Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 20 }] });
    expect(withoutConfirm.status).toBe(200);
    expect(withoutConfirm.body.updated).toBe(0);
    expect(withoutConfirm.body.rows[0].status).toBe("skipped");
    let stillOld = await prisma.sku.findUnique({ where: { id: sku.id } });
    expect(stillOld!.altUnitFactor).toBe(10);

    const withConfirm = await request(app)
      .post("/api/skus/bulk/commit")
      .set(auth(owner.token))
      .send({ rows: [{ code: "R8-COMMIT-FACTOR", name: "Factor Widget", unit: "pc", altUnitName: "Box", altUnitFactor: 20, confirmFactorChange: true }] });
    expect(withConfirm.status).toBe(200);
    expect(withConfirm.body.updated).toBe(1);
    const nowUpdated = await prisma.sku.findUnique({ where: { id: sku.id } });
    expect(nowUpdated!.altUnitFactor).toBe(20);

    const auditEntries = await prisma.auditLog.findMany({ where: { entityType: "Sku", entityId: sku.id, action: "UPDATE" } });
    expect(auditEntries.length).toBeGreaterThan(0);
  });
});
