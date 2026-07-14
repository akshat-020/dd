import { prisma } from "./prisma.js";
import type { Role } from "./roles.js";

// Owner and Warehouse always have scan-based putaway/pick access. Accountant
// never does. Sales staff only have it if individually granted by an Owner
// (the "composable add-on" from the permission model — a base role plus
// optional per-person toggles, rather than a fixed role table).
export async function canUseScanActions(userId: string, role: Role): Promise<boolean> {
  if (role === "OWNER" || role === "WAREHOUSE") return true;
  if (role !== "SALES") return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { canScanPutaway: true } });
  return !!user?.canScanPutaway;
}

// Owner always has inward-entry (SKU + qty + supplier ref + date) access.
// Accountant and Warehouse never do — the physical/quantity event is
// deliberately kept separate from the cost event (PurchaseCostReference,
// Owner+Accountant only) and from shelving it (canUseScanActions). Sales
// staff have it by default (it's part of their normal baseline), but it's
// still a per-user override an Owner can revoke.
export async function canLogInwardEntry(userId: string, role: Role): Promise<boolean> {
  if (role === "OWNER") return true;
  if (role !== "SALES") return false;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { canLogInwardEntry: true } });
  return !!user?.canLogInwardEntry;
}
