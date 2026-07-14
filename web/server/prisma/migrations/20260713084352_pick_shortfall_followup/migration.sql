-- AlterTable
ALTER TABLE "PickListItem" ADD COLUMN     "isShortfallFollowup" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT;
