import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/jwt.js";
import type { Role } from "../lib/roles.js";
import { hasPermission, hasAnyPermission, type PermissionKey } from "../lib/permissions.js";
import { touchSession } from "../lib/session.js";

export interface AuthedRequest extends Request {
  user?: { id: string; role: Role; name: string; sessionId: string };
}

// Verifies the JWT signature/expiry AND that the session it references is
// still live — a JWT alone can't be revoked before its absolute expiry, so
// the session check is what makes "sign this device out remotely" and
// "expire after N minutes of inactivity" actually work (see lib/session.ts).
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  // <img src> tags (used for QR label images) can't set an Authorization
  // header, so those routes accept the token as a query param too.
  const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : queryToken;
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }
  try {
    const payload = verifyToken(token);
    const sessionCheck = await touchSession(payload.sid);
    if (!sessionCheck.ok) {
      const message = sessionCheck.reason === "inactive" ? "Session expired due to inactivity" : "Session has been signed out";
      return res.status(401).json({ error: message });
    }
    req.user = { id: payload.sub, role: payload.role, name: payload.name, sessionId: payload.sid };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Reserved for the handful of things that stay structurally role-based
// rather than an individually-grantable permission — account/permission
// management itself (routes/users.ts) and the audit hash-chain integrity
// check (routes/reports.ts). Per the access-control model, Owner is the
// only unrestricted role; nothing else should reach for this — use
// requirePermission for anything that appears in the permission catalogue.
export function requireRole(...roles: Role[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Forbidden: insufficient role" });
    }
    next();
  };
}

// The general-purpose gate for anything in the permission catalogue.
// Looked up fresh from the DB on every request (rather than baked into the
// JWT) so that an Owner revoking someone's permission takes effect
// immediately, not after the token's 12h expiry. Owner always passes,
// unconditionally (see lib/permissions.ts's hasPermission).
export function requirePermission(permission: PermissionKey) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
    try {
      const allowed = await hasPermission(req.user, permission);
      if (!allowed) {
        return res.status(403).json({ error: `Forbidden: "${permission}" permission not granted` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// For the few routes where any one of several permissions is sufficient
// (e.g. reading company settings, useful to both whoever configures them
// and whoever creates a Proforma Invoice that displays them).
export function requireAnyPermission(...permissions: PermissionKey[]) {
  return async (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
    try {
      const allowed = await hasAnyPermission(req.user, permissions);
      if (!allowed) {
        return res.status(403).json({ error: `Forbidden: none of [${permissions.join(", ")}] granted` });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
