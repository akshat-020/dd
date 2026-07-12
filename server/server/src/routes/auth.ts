import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../lib/jwt.js";
import { isRole } from "../lib/roles.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { createSession, revokeSession } from "../lib/session.js";
import { recordAudit } from "../lib/audit.js";
import { generateTotpSecret, totpKeyUri, verifyTotpCode } from "../lib/totp.js";
import { PASSWORD_POLICY_MESSAGE, passwordSchema } from "../lib/password.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

function publicUser(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  canScanPutaway: boolean;
  canLogInwardEntry: boolean;
  totpEnabled: boolean;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    canScanPutaway: user.canScanPutaway,
    canLogInwardEntry: user.canLogInwardEntry,
    totpEnabled: user.totpEnabled,
  };
}

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const { email, password, totpCode } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  // No audit row for a genuinely unknown email — AuditLog.userId is a
  // required FK to a real account, and there's no user to attribute it to.
  if (!user || !user.active) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    await recordAudit({ userId: user.id, action: "LOGIN_FAILURE", entityType: "User", entityId: user.id, after: { reason: "bad_password" } });
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!isRole(user.role)) {
    return res.status(500).json({ error: "User has an invalid role assignment" });
  }

  if (user.totpEnabled) {
    if (!totpCode || !user.totpSecret || !verifyTotpCode(user.totpSecret, totpCode)) {
      await recordAudit({ userId: user.id, action: "LOGIN_FAILURE", entityType: "User", entityId: user.id, after: { reason: "totp_required_or_invalid" } });
      return res.status(401).json({ error: "Two-factor code required or invalid", requiresTotp: true });
    }
  }

  const session = await createSession(user.id, req.headers["user-agent"]);
  const token = signToken({ sub: user.id, role: user.role, name: user.name, sid: session.id });
  await recordAudit({ userId: user.id, action: "LOGIN_SUCCESS", entityType: "User", entityId: user.id, after: { sessionId: session.id } });

  res.json({ token, user: publicUser(user) });
});

authRouter.post("/logout", requireAuth, async (req: AuthedRequest, res) => {
  await revokeSession(req.user!.sessionId);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(publicUser(user));
});

// ---- Optional TOTP 2FA (opt-in; recommended for Owner/Accountant since
// those roles reach pricing/cost data) ----

authRouter.post("/2fa/enroll", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "User not found" });

  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret, totpEnabled: false } });
  res.json({ secret, otpauthUrl: totpKeyUri(secret, user.email) });
});

const confirmSchema = z.object({ code: z.string().min(6).max(6) });

authRouter.post("/2fa/confirm", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user?.totpSecret) return res.status(400).json({ error: "No 2FA enrollment in progress — call /2fa/enroll first" });
  if (!verifyTotpCode(user.totpSecret, parsed.data.code)) {
    return res.status(400).json({ error: "Invalid code" });
  }

  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true } });
  await recordAudit({ userId: user.id, action: "ENABLE_2FA", entityType: "User", entityId: user.id });
  res.json({ ok: true });
});

const disableSchema = z.object({ password: z.string().min(1) });

authRouter.post("/2fa/disable", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = disableSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });

  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid password" });

  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null } });
  await recordAudit({ userId: user.id, action: "DISABLE_2FA", entityType: "User", entityId: user.id });
  res.json({ ok: true });
});

authRouter.get("/password-policy", (_req, res) => {
  res.json({ message: PASSWORD_POLICY_MESSAGE });
});

export { passwordSchema };
