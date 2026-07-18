import { Router, type Response } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { ROLES } from "../lib/roles.js";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/auth.js";
import { recordAudit } from "../lib/audit.js";
import { passwordSchema } from "../lib/password.js";
import { ALL_PERMISSIONS, ROLE_TEMPLATES, applyRoleTemplate, isPermissionKey, type PermissionKey } from "../lib/permissions.js";

export const usersRouter = Router();

usersRouter.use(requireAuth);

// Account creation AND every permission grant/revoke are Owner-only —
// structurally, not just by role-template default (see the access-control
// model: "Only the Owner can grant/revoke permissions for any account").
// Every route in this file stays requireRole("OWNER"), not
// requirePermission — there's no catalogue entry that makes this
// delegable.

async function serializeUser(user: { id: string; name: string; email: string; role: string; active: boolean; createdAt: Date }) {
  const permissions =
    user.role === "OWNER"
      ? ALL_PERMISSIONS
      : (await prisma.userPermission.findMany({ where: { userId: user.id }, select: { permission: true } }))
          .map((p) => p.permission)
          .filter(isPermissionKey);
  return { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active, createdAt: user.createdAt, permissions };
}

usersRouter.get("/", requireRole("OWNER"), async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  res.json(await Promise.all(users.map(serializeUser)));
});

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: passwordSchema,
  role: z.enum(ROLES),
});

// A role is only ever a starting template, applied once here to save
// re-configuring every permission from scratch for every hire — every
// toggle stays individually adjustable per person from this point on (see
// PATCH/PUT/DELETE .../permissions below). Changing this account's role
// later never re-applies or reconciles the template again.
usersRouter.post("/", requireRole("OWNER"), async (req: AuthedRequest, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
  }
  const { name, email, password, role } = parsed.data;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ error: "Email already in use" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash, role } });
  await applyRoleTemplate(user.id, role, req.user!.id);
  await recordAudit({
    userId: req.user!.id,
    action: "CREATE",
    entityType: "User",
    entityId: user.id,
    after: { name, email, role, templatePermissions: ROLE_TEMPLATES[role] ?? [] },
  });
  res.status(201).json(await serializeUser(user));
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: passwordSchema.optional(),
});

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

  if (parsed.data.role !== undefined && parsed.data.role !== before.role) {
    await recordAudit({
      userId: req.user!.id,
      action: "CHANGE_ROLE",
      entityType: "User",
      entityId: user.id,
      before: { role: before.role },
      after: { role: user.role },
    });
  }
  if (parsed.data.active !== undefined && parsed.data.active !== before.active) {
    await recordAudit({
      userId: req.user!.id,
      action: user.active ? "ACTIVATE" : "DEACTIVATE",
      entityType: "User",
      entityId: user.id,
      before: { active: before.active },
      after: { active: user.active },
    });
  }

  res.json(await serializeUser(user));
});

// ---- Individual permission grants (the core of the access-control model)
// ----
// Every permission is an individual, toggleable capability per person —
// this is where that toggle actually lives, independent of whatever role
// template the account started from. Deny-by-default: granting is the only
// way a permission key not already present becomes true; revoking deletes
// the row outright rather than flipping a boolean, so a permission
// introduced after this account existed starts unassigned exactly like a
// brand new account would see it.

function parsePermissionParam(value: string, res: Response): PermissionKey | null {
  if (!isPermissionKey(value)) {
    res.status(400).json({ error: `Unknown permission "${value}"` });
    return null;
  }
  return value;
}

usersRouter.put("/:id/permissions/:permission", requireRole("OWNER"), async (req: AuthedRequest, res) => {
  const permission = parsePermissionParam(req.params.permission, res);
  if (!permission) return;

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "OWNER") {
    return res.status(400).json({ error: "Owner accounts always have every permission — nothing to grant" });
  }

  const existing = await prisma.userPermission.findUnique({ where: { userId_permission: { userId: target.id, permission } } });
  if (!existing) {
    await prisma.userPermission.create({ data: { userId: target.id, permission, grantedById: req.user!.id } });
    await recordAudit({
      userId: req.user!.id,
      action: "GRANT_PERMISSION",
      entityType: "User",
      entityId: target.id,
      after: { permission },
    });
  }
  res.json(await serializeUser(target));
});

usersRouter.delete("/:id/permissions/:permission", requireRole("OWNER"), async (req: AuthedRequest, res) => {
  const permission = parsePermissionParam(req.params.permission, res);
  if (!permission) return;

  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "User not found" });
  if (target.role === "OWNER") {
    return res.status(400).json({ error: "Owner accounts always have every permission — nothing to revoke" });
  }

  const existing = await prisma.userPermission.findUnique({ where: { userId_permission: { userId: target.id, permission } } });
  if (existing) {
    await prisma.userPermission.delete({ where: { id: existing.id } });
    await recordAudit({
      userId: req.user!.id,
      action: "REVOKE_PERMISSION",
      entityType: "User",
      entityId: target.id,
      before: { permission },
    });
  }
  res.json(await serializeUser(target));
});
