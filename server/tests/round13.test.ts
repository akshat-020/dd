import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { createUser } from "./helpers.js";

// Opening Stock import: an onboarding-only way to declare a starting
// physical position (SKU + Location + qty, base unit) without fabricating
// a fake purchase/production history — logged as its own StockMovement
// type so it's never mistaken for a real inward event, Owner-only so it
// can't become a shortcut around the normal inward/reconciliation flows
// after go-live.

const app = createApp();

let owner: Awaited<ReturnType<typeof createUser>>;
let accountant: Awaited<ReturnType<typeof createUser>>;
let warehouse: Awaited<ReturnType<typeof createUser>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  [owner, accountant, warehouse] = await Promise.all([createUser("OWNER"), createUser("ACCOUNTANT"), createUser("WAREHOUSE")]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function stockAt(skuId: string, locationId: string) {
  const row = await prisma.stockItem.findFirst({ where: { skuId, locationId } });
  return row?.quantity ?? 0;
}

describe("Opening Stock import — Owner-only", () => {
  it("rejects a non-Owner account (Accountant, even with inventory.viewStockFull by template) on every route", async () => {
    const template = await request(app).get("/api/opening-stock/template").set(auth(accountant.token));
    expect(template.status).toBe(403);
    const preview = await request(app).post("/api/opening-stock/preview").set(auth(accountant.token)).send({ rows: [] });
    expect(preview.status).toBe(403);
    const commit = await request(app).post("/api/opening-stock/commit").set(auth(accountant.token)).send({ rows: [] });
    expect(commit.status).toBe(403);
  });

  it("rejects Warehouse too, despite masterdata.bulkImportSku in its default template", async () => {
    const res = await request(app).post("/api/opening-stock/preview").set(auth(warehouse.token)).send({ rows: [{ skuCode: "x", locationCode: "y", quantity: 1 }] });
    expect(res.status).toBe(403);
  });
});

describe("Opening Stock import — preview validation, no side effects", () => {
  it("flags missing/unknown SKU and location codes and non-positive quantities, without writing anything", async () => {
    const sku = await prisma.sku.create({ data: { code: "R13-SKU-1", name: "Round13 Widget", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R13-LOC-1", zone: "R13", rack: "01" } });

    const res = await request(app)
      .post("/api/opening-stock/preview")
      .set(auth(owner.token))
      .send({
        rows: [
          { skuCode: sku.code, locationCode: loc.code, quantity: 50 }, // valid
          { skuCode: "NOPE", locationCode: loc.code, quantity: 10 }, // unknown SKU
          { skuCode: sku.code, locationCode: "NOPE", quantity: 10 }, // unknown location
          { skuCode: sku.code, locationCode: loc.code, quantity: 0 }, // non-positive
          { skuCode: sku.code, locationCode: loc.code, quantity: -5 }, // negative
          { skuCode: sku.code, locationCode: loc.code }, // missing quantity
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ toApply: 1, errors: 5 });
    expect(res.body.rows[0].action).toBe("apply");
    for (const row of res.body.rows.slice(1)) {
      expect(row.action).toBe("error");
      expect(row.errors.length).toBeGreaterThan(0);
    }

    const stock = await stockAt(sku.id, loc.id);
    expect(stock).toBe(0); // preview never applies anything
  });

  it("flags an unparseable date", async () => {
    const sku = await prisma.sku.create({ data: { code: "R13-SKU-2", name: "Round13 Widget 2", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R13-LOC-2", zone: "R13", rack: "01" } });
    const res = await request(app)
      .post("/api/opening-stock/preview")
      .set(auth(owner.token))
      .send({ rows: [{ skuCode: sku.code, locationCode: loc.code, quantity: 10, date: "not-a-date" }] });
    expect(res.body.rows[0].action).toBe("error");
    expect(res.body.rows[0].errors[0]).toMatch(/date/i);
  });
});

describe("Opening Stock import — commit applies stock as a distinct movement type", () => {
  it("applies valid rows, skips invalid ones (partial commit), and tags the movement OPENING_STOCK — not INBOUND", async () => {
    const sku = await prisma.sku.create({ data: { code: "R13-SKU-3", name: "Round13 Widget 3", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R13-LOC-3", zone: "R13", rack: "01" } });

    const res = await request(app)
      .post("/api/opening-stock/commit")
      .set(auth(owner.token))
      .send({
        rows: [
          { skuCode: sku.code, locationCode: loc.code, quantity: 75 },
          { skuCode: "NOPE", locationCode: loc.code, quantity: 5 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.skipped).toBe(1);

    const stock = await stockAt(sku.id, loc.id);
    expect(stock).toBe(75);

    const movements = await request(app).get(`/api/stock/movements?skuId=${sku.id}&type=OPENING_STOCK`).set(auth(owner.token));
    expect(movements.status).toBe(200);
    expect(movements.body).toHaveLength(1);
    expect(movements.body[0].type).toBe("OPENING_STOCK");
    expect(movements.body[0].quantity).toBe(75);

    // Never surfaces as a regular INBOUND movement for this SKU.
    const inbound = await request(app).get(`/api/stock/movements?skuId=${sku.id}&type=INBOUND`).set(auth(owner.token));
    expect(inbound.body).toHaveLength(0);
  });

  it("an optional batchCode creates a SkuBatch tagged sourceType OPENING_STOCK, reused across rows for the same SKU+batch", async () => {
    const sku = await prisma.sku.create({ data: { code: "R13-SKU-4", name: "Round13 Widget 4", unit: "pc" } });
    const locA = await prisma.location.create({ data: { code: "R13-LOC-4A", zone: "R13", rack: "01" } });
    const locB = await prisma.location.create({ data: { code: "R13-LOC-4B", zone: "R13", rack: "02" } });

    await request(app)
      .post("/api/opening-stock/commit")
      .set(auth(owner.token))
      .send({
        rows: [
          { skuCode: sku.code, locationCode: locA.code, quantity: 20, batchCode: "OPEN-LOT-1" },
          { skuCode: sku.code, locationCode: locB.code, quantity: 30, batchCode: "OPEN-LOT-1" },
        ],
      });

    const batches = await prisma.skuBatch.findMany({ where: { skuId: sku.id, batchCode: "OPEN-LOT-1" } });
    expect(batches).toHaveLength(1); // reused, not duplicated
    expect(batches[0].sourceType).toBe("OPENING_STOCK");

    const movements = await prisma.stockMovement.findMany({ where: { skuId: sku.id, type: "OPENING_STOCK" } });
    expect(movements.every((m) => m.batchId === batches[0].id)).toBe(true);
  });

  it("an optional date backdates the movement's createdAt to the declared 'as of' date", async () => {
    const sku = await prisma.sku.create({ data: { code: "R13-SKU-5", name: "Round13 Widget 5", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R13-LOC-5", zone: "R13", rack: "01" } });
    const backdate = "2026-01-01T00:00:00.000Z";

    await request(app)
      .post("/api/opening-stock/commit")
      .set(auth(owner.token))
      .send({ rows: [{ skuCode: sku.code, locationCode: loc.code, quantity: 40, date: backdate }] });

    const movement = await prisma.stockMovement.findFirst({ where: { skuId: sku.id, type: "OPENING_STOCK" } });
    expect(movement!.createdAt.toISOString()).toBe(backdate);
  });

  it("records one AuditLog entry per commit, summarizing what was applied", async () => {
    const sku = await prisma.sku.create({ data: { code: "R13-SKU-6", name: "Round13 Widget 6", unit: "pc" } });
    const loc = await prisma.location.create({ data: { code: "R13-LOC-6", zone: "R13", rack: "01" } });

    const before = await prisma.auditLog.count({ where: { entityType: "OpeningStock" } });
    await request(app)
      .post("/api/opening-stock/commit")
      .set(auth(owner.token))
      .send({ rows: [{ skuCode: sku.code, locationCode: loc.code, quantity: 15 }] });
    const after = await prisma.auditLog.count({ where: { entityType: "OpeningStock" } });
    expect(after).toBe(before + 1);
  });
});
