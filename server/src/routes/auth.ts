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
import { ALL_PERMISSIONS, isPermissionKey } from "../lib/permissions.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional(),
});

// The client drives every permission-gated bit of UI off this list — Owner
// gets the full catalogue back (Owner bypasses the UserPermission table
// entirely server-side, so there's nothing to look up), everyone else gets
// exactly the rows actually granted to them. No separate "role" branching
// needed client-side: it's just membership in this array everywhere.
async function publicUser(user: { id: string; name: string; email: string; role: string; totpEnabled: boolean }) {
  const permissions =
    user.role === "OWNER"
      ? ALL_PERMISSIONS
      : (await prisma.userPermission.findMany({ where: { userId: user.id }, select: { permission: true } }))
          .map((p) => p.permission)
          .filter(isPermissionKey);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    totpEnabled: user.totpEnabled,
    permissions,
  };
}

const bootstrapSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: passwordSchema,
  setupSecret: z.string().min(1),
});

// Creates the very first account (as OWNER) in an otherwise-empty database.
// Every other user-creation path requires an existing Owner's token
// (POST /api/users), which is exactly right day-to-day but leaves a fresh
// production deployment with no way to log in at all — there's no seed
// data in prod (prisma/seed.ts is dev/demo-only, and its hardcoded
// "password123" accounts must never touch a real deployment). This route
// is self-limiting: it only ever succeeds once, the moment the User table
// has its first row it's permanently a 403 for everyone, so it's safe to
// leave deployed rather than something to remove after use.
//
// Also gated on BOOTSTRAP_SECRET (a one-time value only the deployer knows,
// set as an env var) — without it, whoever hits this endpoint first after
// deploy (not necessarily the actual business owner) would win the Owner
// account, in the window between "deploy finished" and "the real owner got
// around to setting up their account."
authRouter.post("/bootstrap", async (req, res) => {
  const existingCount = await prisma.user.count();
  if (existingCount > 0) {
    return res.status(403).json({ error: "Setup already completed — an account already exists. Ask an Owner to create your account instead." });
  }
  const parsed = bootstrapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  if (!process.env.BOOTSTRAP_SECRET || parsed.data.setupSecret !== process.env.BOOTSTRAP_SECRET) {
    return res.status(403).json({ error: "Invalid setup secret" });
  }
  const { name, email, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash, role: "OWNER" } });
  await recordAudit({ userId: user.id, action: "BOOTSTRAP_OWNER", entityType: "User", entityId: user.id, after: { email } });

  const session = await createSession(user.id, req.headers["user-agent"]);
  const token = signToken({ sub: user.id, role: "OWNER", name: user.name, sid: session.id });
  res.status(201).json({ token, user: await publicUser(user) });
});

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

  res.json({ token, user: await publicUser(user) });
});

authRouter.post("/logout", requireAuth, async (req: AuthedRequest, res) => {
  await revokeSession(req.user!.sessionId);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(await publicUser(user));
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
