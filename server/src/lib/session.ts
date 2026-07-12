import { prisma } from "./prisma.js";

// Inactivity window before a session is treated as expired, even if its
// JWT hasn't hit its absolute expiry yet — relevant for scan/putaway
// sessions on shared warehouse-floor phones, where one staff member's
// login shouldn't stay live for whoever picks up the device next.
const SESSION_INACTIVITY_MS = Number(process.env.SESSION_INACTIVITY_MINUTES ?? 30) * 60 * 1000;

export async function createSession(userId: string, userAgent?: string) {
  return prisma.session.create({ data: { userId, userAgent } });
}

export interface SessionCheckResult {
  ok: boolean;
  reason?: "not_found" | "revoked" | "inactive";
}

// Validates a session and, if valid, refreshes lastSeenAt (sliding
// inactivity window) in the same call.
export async function touchSession(sessionId: string): Promise<SessionCheckResult> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return { ok: false, reason: "not_found" };
  if (session.revokedAt) return { ok: false, reason: "revoked" };
  if (Date.now() - session.lastSeenAt.getTime() > SESSION_INACTIVITY_MS) {
    await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    return { ok: false, reason: "inactive" };
  }
  await prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date() } });
  return { ok: true };
}

export async function revokeSession(sessionId: string) {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}
