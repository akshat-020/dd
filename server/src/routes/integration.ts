import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { effectiveRecordCalls, normalizePhone } from "../lib/parties.js";
import {
  INTEGRATION_SCOPES,
  generateIntegrationToken,
  hashIntegrationToken,
  requireIntegrationToken,
} from "../lib/integrationTokens.js";

// ---------------------------------------------------------------------------
// Caller lookup for the call desk (docs/call-desk/COMBINED_PLAN.md, join J2).
//
// The telephony/automation layer calls this on every incoming call, with a
// short timeout, to decide where the call rings and what the front desk sees.
// It deliberately returns NO prices or amounts — only who the caller is and
// the status of their recent orders. Drafts are excluded (they are private
// to whoever created them; see routes/orders.ts canAccessOrder).
// ---------------------------------------------------------------------------
export const integrationRouter = Router();

const RECENTLY_DISPATCHED_DAYS = 7;
const MAX_ORDERS = 5;

integrationRouter.get("/lookup", requireIntegrationToken("party.lookup"), async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!phone) return res.status(400).json({ error: "A valid phone query parameter is required" });

  const entry = await prisma.partyPhone.findUnique({ where: { phone }, include: { party: true } });
  if (!entry) return res.json({ phone, found: false });

  const { party } = entry;
  const since = new Date(Date.now() - RECENTLY_DISPATCHED_DAYS * 24 * 60 * 60 * 1000);
  const orders = await prisma.order.findMany({
    where: {
      partyId: party.id,
      OR: [{ status: { in: ["FINALIZED", "LOADED"] } }, { status: "COMPLETED", completedAt: { gte: since } }],
    },
    select: {
      orderNumber: true,
      status: true,
      createdAt: true,
      finalizedAt: true,
      loadedAt: true,
      completedAt: true,
      _count: { select: { lines: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_ORDERS,
  });

  res.json({
    phone,
    found: true,
    party: {
      id: party.id,
      name: party.name,
      firm: party.firm,
      city: party.city,
      tag: party.tag,
      ownerStaff: party.ownerStaff,
      backupStaff: party.backupStaff,
      language: party.language,
      voiceOnly: party.voiceOnly,
      recordCalls: effectiveRecordCalls(party),
    },
    orders: orders.map(({ _count, ...o }) => ({ ...o, lineCount: _count.lines })),
  });
});

// ---------------------------------------------------------------------------
// Owner-only token management.
// ---------------------------------------------------------------------------
export const integrationTokensRouter = Router();

integrationTokensRouter.use(requireAuth, requireRole("OWNER"));

const tokenSelect = { id: true, name: true, scopes: true, createdAt: true, lastUsedAt: true, revokedAt: true } as const;

integrationTokensRouter.get("/", async (_req, res) => {
  const tokens = await prisma.integrationToken.findMany({ select: tokenSelect, orderBy: { createdAt: "desc" } });
  res.json(tokens.map((t) => ({ ...t, scopes: t.scopes.split(",") })));
});

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(INTEGRATION_SCOPES)).min(1).default(["party.lookup"]),
});

// The plaintext token is returned exactly once, here. Only its hash is stored.
integrationTokensRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = createTokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  const token = generateIntegrationToken();
  const row = await prisma.integrationToken.create({
    data: {
      name: parsed.data.name,
      scopes: [...new Set(parsed.data.scopes)].join(","),
      tokenHash: hashIntegrationToken(token),
      createdById: req.user!.id,
    },
    select: tokenSelect,
  });
  await recordAudit({ userId: req.user!.id, action: "CREATE", entityType: "IntegrationToken", entityId: row.id, after: row });
  res.status(201).json({ ...row, scopes: row.scopes.split(","), token });
});

integrationTokensRouter.post("/:id/revoke", async (req: AuthedRequest, res) => {
  const existing = await prisma.integrationToken.findUnique({ where: { id: req.params.id }, select: tokenSelect });
  if (!existing) return res.status(404).json({ error: "Token not found" });
  if (existing.revokedAt) return res.json({ ...existing, scopes: existing.scopes.split(",") });
  const row = await prisma.integrationToken.update({ where: { id: existing.id }, data: { revokedAt: new Date() }, select: tokenSelect });
  await recordAudit({ userId: req.user!.id, action: "REVOKE", entityType: "IntegrationToken", entityId: row.id, before: existing, after: row });
  res.json({ ...row, scopes: row.scopes.split(",") });
});
