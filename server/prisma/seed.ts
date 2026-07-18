import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { applyRoleTemplate } from "../src/lib/permissions.js";

const prisma = new PrismaClient();

async function main() {
  const password = await bcrypt.hash("password123", 10);

  const [owner, accountant, sales, warehouse] = await Promise.all([
    prisma.user.upsert({
      where: { email: "owner@example.com" },
      update: {},
      create: { name: "Owner", email: "owner@example.com", passwordHash: password, role: "OWNER" },
    }),
    prisma.user.upsert({
      where: { email: "accountant@example.com" },
      update: {},
      create: { name: "Accountant", email: "accountant@example.com", passwordHash: password, role: "ACCOUNTANT" },
    }),
    prisma.user.upsert({
      where: { email: "sales@example.com" },
      update: {},
      create: { name: "Sales Staff", email: "sales@example.com", passwordHash: password, role: "SALES" },
    }),
    prisma.user.upsert({
      where: { email: "warehouse@example.com" },
      update: {},
      create: { name: "Warehouse Staff", email: "warehouse@example.com", passwordHash: password, role: "WAREHOUSE" },
    }),
  ]);

  // Role is only ever a starting template — apply each seeded account's
  // default permission set the same way a real account creation would
  // (see routes/users.ts). Owner bypasses the permission table entirely,
  // so it's skipped here. `createMany({ skipDuplicates: true })` inside
  // applyRoleTemplate makes this safe to re-run on every `npm run seed`.
  await Promise.all([
    applyRoleTemplate(accountant.id, "ACCOUNTANT", owner.id),
    applyRoleTemplate(sales.id, "SALES", owner.id),
    applyRoleTemplate(warehouse.id, "WAREHOUSE", owner.id),
  ]);

  const locations = await Promise.all(
    [
      { code: "A-01-01", zone: "A", rack: "01", bin: "01" },
      { code: "A-01-02", zone: "A", rack: "01", bin: "02" },
      { code: "A-02-01", zone: "A", rack: "02", bin: "01" },
      { code: "B-01-01", zone: "B", rack: "01", bin: "01" },
    ].map((l) => prisma.location.upsert({ where: { code: l.code }, update: {}, create: l }))
  );

  const skus = await Promise.all(
    [
      { code: "CEM-50KG", name: "Cement 50kg Bag", unit: "bag", category: "Cement", reorderThreshold: 50 },
      { code: "STL-8MM", name: "Steel Rod 8mm", unit: "piece", category: "Steel", reorderThreshold: 100 },
      { code: "PNT-20L", name: "Paint 20L Drum", unit: "drum", category: "Paint", reorderThreshold: 10 },
    ].map((s) => prisma.sku.upsert({ where: { code: s.code }, update: {}, create: s }))
  );

  const batch = await prisma.skuBatch.upsert({
    where: { skuId_batchCode: { skuId: skus[0].id, batchCode: "SEED-BATCH-1" } },
    update: {},
    create: {
      skuId: skus[0].id,
      batchCode: "SEED-BATCH-1",
      sourceType: "PURCHASE",
      receivedQuantity: 200,
      supplierRef: "SEED-PO-1",
      note: "Initial seed stock",
    },
  });

  const existingStock = await prisma.stockItem.findFirst({
    where: { skuId: skus[0].id, locationId: locations[0].id, batchId: batch.id },
  });
  if (!existingStock) {
    await prisma.stockItem.create({ data: { skuId: skus[0].id, locationId: locations[0].id, batchId: batch.id, quantity: 200 } });
    await prisma.stockMovement.create({
      data: {
        skuId: skus[0].id,
        locationId: locations[0].id,
        batchId: batch.id,
        quantity: 200,
        type: "INBOUND",
        reason: "Seed data",
        userId: owner.id,
      },
    });
  }

  const existingStock2 = await prisma.stockItem.findFirst({
    where: { skuId: skus[1].id, locationId: locations[1].id, batchId: null },
  });
  if (!existingStock2) {
    await prisma.stockItem.create({ data: { skuId: skus[1].id, locationId: locations[1].id, quantity: 500 } });
    await prisma.stockMovement.create({
      data: { skuId: skus[1].id, locationId: locations[1].id, quantity: 500, type: "INBOUND", reason: "Seed data", userId: owner.id },
    });
  }

  console.log("Seed complete. Login with any of:");
  console.log("  owner@example.com / password123");
  console.log("  accountant@example.com / password123");
  console.log("  sales@example.com / password123");
  console.log("  warehouse@example.com / password123");
  console.log({ owner: owner.id, accountant: accountant.id, sales: sales.id, warehouse: warehouse.id });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
