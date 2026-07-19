import { decryptNumber } from "./crypto.js";

// Which of a SKU's two Default Price (MRP) fields applies to a given line
// depends on which unit that line is actually in — Box and Pcs are priced
// independently (see the unit-conversion addendum), there's no single "the"
// default. Always a prefill hint alongside a line's real, explicitly-set
// price — never applied automatically, and never retroactive to a price
// already set. Shared between routes/orders.ts (order-line display) and
// routes/pricing.ts (the dedicated pricing endpoint) so the two never drift.
export function skuDefaultPriceForUnit(
  sku: { altUnitName: string | null; defaultPrice: string | null; defaultAltUnitPrice: string | null },
  lineUnit: string | null
) {
  const isAltUnit = lineUnit != null && sku.altUnitName != null && lineUnit === sku.altUnitName;
  const raw = isAltUnit ? sku.defaultAltUnitPrice : sku.defaultPrice;
  return raw ? decryptNumber(raw) : null;
}
