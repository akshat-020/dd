// Shared by every bulk-import endpoint (SKU master, Opening Stock, ...).
// Cells arrive as whatever the client-side sheet parser produced (string,
// number, or blank/undefined) — never assumed to already be the right type.

export function cellToString(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

// Returns undefined for a blank cell, NaN for a present-but-unparseable
// cell (the caller distinguishes the two), or the parsed number otherwise.
export function cellToNumber(v: unknown): number | undefined {
  const s = cellToString(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
