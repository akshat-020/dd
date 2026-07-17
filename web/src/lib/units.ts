import type { Sku } from "../api/types";

// Mirrors server/src/lib/units.ts — pure display formatting, no network
// calls, so every screen that already has the SKU (and a base-unit
// quantity) in hand can show the compound Box/Pcs breakdown without an
// extra round trip.

export function compoundBreakdown(baseQty: number, sku: Pick<Sku, "unit" | "altUnitName" | "altUnitFactor">): string | null {
  if (!sku.altUnitName || !sku.altUnitFactor) return null;
  const boxes = Math.floor(baseQty / sku.altUnitFactor);
  const pcs = baseQty % sku.altUnitFactor;
  return pcs > 0 ? `${boxes} ${sku.altUnitName} + ${pcs} ${sku.unit}` : `${boxes} ${sku.altUnitName}`;
}

export function toBaseQty(unitQty: number, unit: string, sku: Pick<Sku, "unit" | "altUnitName" | "altUnitFactor">): number {
  if (unit === sku.unit) return unitQty;
  if (unit === sku.altUnitName && sku.altUnitFactor) return unitQty * sku.altUnitFactor;
  return unitQty;
}

export function availableUnits(sku: Pick<Sku, "unit" | "altUnitName" | "altUnitFactor">): string[] {
  return sku.altUnitName && sku.altUnitFactor ? [sku.unit, sku.altUnitName] : [sku.unit];
}
