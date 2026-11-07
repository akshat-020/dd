-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "partyId" TEXT;

-- CreateTable
CREATE TABLE "Party" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firm" TEXT,
    "city" TEXT,
    "tag" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "ownerStaff" TEXT,
    "backupStaff" TEXT,
    "language" TEXT,
    "voiceOnly" BOOLEAN NOT NULL DEFAULT false,
    "recordCalls" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartyPhone" (
    "phone" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartyPhone_pkey" PRIMARY KEY ("phone")
);

-- CreateTable
CREATE TABLE "IntegrationToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "IntegrationToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartyPhone_partyId_idx" ON "PartyPhone"("partyId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationToken_tokenHash_key" ON "IntegrationToken"("tokenHash");

-- CreateIndex
CREATE INDEX "Order_partyId_idx" ON "Order"("partyId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartyPhone" ADD CONSTRAINT "PartyPhone_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE CASCADE ON UPDATE CASCADE;
