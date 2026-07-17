-- AlterTable
ALTER TABLE "PickListItem" ADD COLUMN     "orderLineId" TEXT;

-- Best-effort backfill for rows created before this column existed: when a
-- (orderId, skuId) pair has exactly one matching OrderLine, that's
-- unambiguously the line this pick item belongs to. When a SKU appears on
-- more than one line of the same order, there's no way to know which line
-- an old row belonged to (that ambiguity is exactly the bug this migration
-- fixes going forward) — those rows are left NULL rather than guessed at.
UPDATE "PickListItem" p
SET "orderLineId" = ol.id
FROM "OrderLine" ol
WHERE ol."orderId" = p."orderId"
  AND ol."skuId" = p."skuId"
  AND (
    SELECT COUNT(*) FROM "OrderLine" ol2
    WHERE ol2."orderId" = p."orderId" AND ol2."skuId" = p."skuId"
  ) = 1;

-- AddForeignKey
ALTER TABLE "PickListItem" ADD CONSTRAINT "PickListItem_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
