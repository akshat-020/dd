import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/jwt.js";
import type { Role } from "../lib/roles.js";

export interface AuthedRequest extends Request {
  user?: { id: string; role: Role; name: string };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
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
    req.user = { id: payload.sub, role: payload.role, name: payload.name };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

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
