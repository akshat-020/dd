-- AlterTable
ALTER TABLE "SkuBatch" ADD COLUMN "receivedQuantity" INTEGER;
ALTER TABLE "SkuBatch" ADD COLUMN "supplierRef" TEXT;

-- CreateTable
CREATE TABLE "PurchaseCostReference" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" REAL NOT NULL,
    "supplierRef" TEXT,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseCostReference_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "SkuBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PurchaseCostReference_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "canScanPutaway" BOOLEAN NOT NULL DEFAULT false,
    "canLogInwardEntry" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_User" ("active", "canScanPutaway", "createdAt", "email", "id", "name", "passwordHash", "role") SELECT "active", "canScanPutaway", "createdAt", "email", "id", "name", "passwordHash", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
