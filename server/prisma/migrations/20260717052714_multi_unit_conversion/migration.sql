-- AlterTable
ALTER TABLE "InvoiceReferenceLine" ADD COLUMN     "qtyBaseUnits" INTEGER,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "unitFactor" INTEGER;

-- AlterTable
ALTER TABLE "OrderLine" ADD COLUMN     "finalFactor" INTEGER,
ADD COLUMN     "finalUnit" TEXT,
ADD COLUMN     "finalUnitQty" INTEGER,
ADD COLUMN     "requestedFactor" INTEGER,
ADD COLUMN     "requestedUnit" TEXT,
ADD COLUMN     "requestedUnitQty" INTEGER;

-- AlterTable
ALTER TABLE "PickListItem" ADD COLUMN     "boxesOpened" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pickedUnit" TEXT,
ADD COLUMN     "pickedUnitQty" INTEGER;

-- AlterTable
ALTER TABLE "Sku" ADD COLUMN     "altUnitFactor" INTEGER,
ADD COLUMN     "altUnitName" TEXT;
