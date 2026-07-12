import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ROLES } from "../lib/roles.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";

export const usersRouter = Router();

usersRouter.use(requireAuth);

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(ROLES),
});

// Owner manages all staff accounts (roles/permissions are a must-have per
// the brief, so account creation itself is restricted to the Owner).
usersRouter.get("/", requireRole("OWNER"), async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true, canScanPutaway: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(users);
});

usersRouter.post("/", requireRole("OWNER"), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const { name, email, password, role } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already in use" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, email, passwordHash, role },
  });
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: z.string().min(6).optional(),
  canScanPutaway: z.boolean().optional(),
});

// Only Owner can reach this route at all (requireRole above), which is what
// makes granting/revoking canScanPutaway an Owner-only action — same gate
// as every other field on this endpoint, no separate check needed.
usersRouter.patch("/:id", requireRole("OWNER"), async (req: AuthedRequest, res) => {
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const before = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "User not found" });

  const { password, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (password) data.passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.update({ where: { id: req.params.id }, data });

  if (parsed.data.canScanPutaway !== undefined && parsed.data.canScanPutaway !== before.canScanPutaway) {
    await recordAudit({
      userId: req.user!.id,
      action: parsed.data.canScanPutaway ? "GRANT_SCAN_ACCESS" : "REVOKE_SCAN_ACCESS",
      entityType: "User",
      entityId: user.id,
      before: { canScanPutaway: before.canScanPutaway },
      after: { canScanPutaway: user.canScanPutaway },
    });
  }

  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, canScanPutaway: user.canScanPutaway });
});
