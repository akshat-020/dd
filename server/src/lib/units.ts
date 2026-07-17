// Per-SKU compound unit conversion (e.g. Box = 10 pcs for one SKU, Box = 12
// pcs for another — never a global constant). All stock quantities are
// tracked internally in the SKU's base unit; this module is the single
// choke point for resolving a caller-supplied unit name to its conversion
// factor and for formatting a base-unit quantity back into a compound
// Box/Pcs breakdown for display.

export interface UnitAwareSku {
  unit: string;
  altUnitName?: string | null;
  altUnitFactor?: number | null;
}

export class InvalidUnitError extends Error {}

// Resolves a caller-supplied unit name against a SKU's configured units.
// Omitting `unit` (or passing the SKU's own base unit) always resolves to
// factor 1. Throws InvalidUnitError for anything else that isn't the SKU's
// configured alternate unit.
export function resolveUnitFactor(sku: UnitAwareSku, unit: string | undefined | null): { unit: string; factor: number } {
  if (!unit || unit === sku.unit) return { unit: sku.unit, factor: 1 };
  if (sku.altUnitName && unit === sku.altUnitName) {
    if (!sku.altUnitFactor) {
      throw new InvalidUnitError(`This SKU has no conversion factor configured for "${unit}"`);
    }
    return { unit, factor: sku.altUnitFactor };
  }
  const expected = sku.altUnitName ? `"${sku.unit}" or "${sku.altUnitName}"` : `"${sku.unit}"`;
  throw new InvalidUnitError(`Unit "${unit}" is not valid for this SKU (expected ${expected})`);
}

export function toBaseQty(unitQty: number, factor: number): number {
  return unitQty * factor;
}

// "163 pcs -> 16 Box + 3 pcs" — pure display computation from the total
// base-unit quantity, not a separately tracked boxed/loose split (see the
// PickListItem.boxesOpened comment in schema.prisma for why a box-break
// doesn't need to change this math).
export function compoundBreakdown(baseQty: number, sku: UnitAwareSku): { boxes: number; pcs: number; label: string } | null {
  if (!sku.altUnitName || !sku.altUnitFactor) return null;
  const boxes = Math.floor(baseQty / sku.altUnitFactor);
  const pcs = baseQty % sku.altUnitFactor;
  const label = pcs > 0 ? `${boxes} ${sku.altUnitName} + ${pcs} ${sku.unit}` : `${boxes} ${sku.altUnitName}`;
  return { boxes, pcs, label };
}
