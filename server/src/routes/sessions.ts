import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { revokeSession } from "../lib/session.js";
import { recordAudit } from "../lib/audit.js";

export const sessionsRouter = Router();

sessionsRouter.use(requireAuth);

// My own active sessions — lets any staff member see (and sign out of)
// their own logged-in devices, e.g. after realizing they left a shared
// warehouse phone logged in.
sessionsRouter.get("/mine", async (req: AuthedRequest, res) => {
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, revokedAt: null },
    orderBy: { lastSeenAt: "desc" },
  });
  res.json(sessions.map((s) => ({ ...s, current: s.id === req.user!.sessionId })));
});

sessionsRouter.post("/revoke-all-mine", async (req: AuthedRequest, res) => {
  const result = await prisma.session.updateMany({
    where: { userId: req.user!.id, revokedAt: null, id: { not: req.user!.sessionId } },
    data: { revokedAt: new Date() },
  });
  res.json({ revoked: result.count });
});

// Owner-only: every active session across every account — this is the
// "lost phone" / "someone left the company" remote-revocation view. Takes
// effect immediately, not after a password change would eventually expire
// a stale token.
sessionsRouter.get("/", requireRole("OWNER"), async (_req, res) => {
  const sessions = await prisma.session.findMany({
    where: { revokedAt: null },
    include: { user: { select: { id: true, name: true, email: true, role: true } } },
    orderBy: { lastSeenAt: "desc" },
  });
  res.json(sessions);
});

sessionsRouter.post("/:id/revoke", async (req: AuthedRequest, res) => {
  const session = await prisma.session.findUnique({ where: { id: req.params.id } });
  if (!session) return res.status(404).json({ error: "Session not found" });

  const isOwnSession = session.userId === req.user!.id;
  if (!isOwnSession && req.user!.role !== "OWNER") {
    return res.status(403).json({ error: "Forbidden: can only revoke your own session" });
  }

  await revokeSession(session.id);
  await recordAudit({
    userId: req.user!.id,
    action: "REVOKE_SESSION",
    entityType: "Session",
    entityId: session.id,
    after: { revokedUserId: session.userId, revokedBySelf: isOwnSession },
  });
  res.json({ ok: true });
});
