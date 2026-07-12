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
