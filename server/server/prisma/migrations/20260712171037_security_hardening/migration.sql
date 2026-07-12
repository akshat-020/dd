/*
  Warnings:

  - Added the required column `hash` to the `AuditLog` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousHash" TEXT,
    "hash" TEXT NOT NULL,
    CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AuditLog" ("action", "after", "before", "createdAt", "entityId", "entityType", "id", "userId") SELECT "action", "after", "before", "createdAt", "entityId", "entityType", "id", "userId" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE TABLE "new_InvoiceReferenceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceReferenceId" TEXT NOT NULL,
    "skuId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "price" TEXT NOT NULL,
    CONSTRAINT "InvoiceReferenceLine_invoiceReferenceId_fkey" FOREIGN KEY ("invoiceReferenceId") REFERENCES "InvoiceReference" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceReferenceLine_skuId_fkey" FOREIGN KEY ("skuId") REFERENCES "Sku" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_InvoiceReferenceLine" ("id", "invoiceReferenceId", "price", "qty", "skuId") SELECT "id", "invoiceReferenceId", "price", "qty", "skuId" FROM "InvoiceReferenceLine";
DROP TABLE "InvoiceReferenceLine";
ALTER TABLE "new_InvoiceReferenceLine" RENAME TO "InvoiceReferenceLine";
CREATE TABLE "new_OrderLinePrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderLineId" TEXT NOT NULL,
    "unitPrice" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedById" TEXT NOT NULL,
    CONSTRAINT "OrderLinePrice_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_OrderLinePrice" ("id", "orderLineId", "unitPrice", "updatedAt", "updatedById") SELECT "id", "orderLineId", "unitPrice", "updatedAt", "updatedById" FROM "OrderLinePrice";
DROP TABLE "OrderLinePrice";
ALTER TABLE "new_OrderLinePrice" RENAME TO "OrderLinePrice";
CREATE UNIQUE INDEX "OrderLinePrice_orderLineId_key" ON "OrderLinePrice"("orderLineId");
CREATE TABLE "new_PurchaseCostReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" TEXT NOT NULL,
    "supplierRef" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseCostReference_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SkuBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseCostReference_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PurchaseCostReference" ("batchId", "createdAt", "createdById", "id", "note", "quantity", "supplierRef", "unitCost") SELECT "batchId", "createdAt", "createdById", "id", "note", "quantity", "supplierRef", "unitCost" FROM "PurchaseCostReference";
DROP TABLE "PurchaseCostReference";
ALTER TABLE "new_PurchaseCostReference" RENAME TO "PurchaseCostReference";
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canScanPutaway" BOOLEAN NOT NULL DEFAULT false,
    "canLogInwardEntry" BOOLEAN NOT NULL DEFAULT true,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false
);
INSERT INTO "new_User" ("active", "canLogInwardEntry", "canScanPutaway", "createdAt", "email", "id", "name", "passwordHash", "role") SELECT "active", "canLogInwardEntry", "canScanPutaway", "createdAt", "email", "id", "name", "passwordHash", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
