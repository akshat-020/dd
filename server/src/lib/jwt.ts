import jwt from "jsonwebtoken";
import type { Role } from "./roles.js";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}
const JWT_SECRET: string = process.env.JWT_SECRET;

export interface AuthTokenPayload {
  sub: string;
  role: Role;
  name: string;
  // Server-side Session row id. This is what makes inactivity-based expiry
  // and immediate remote revocation possible — a pure stateless JWT can't
  // do either on its own (see middleware/auth.ts requireAuth).
  sid: string;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "12h" });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, JWT_SECRET) as unknown as AuthTokenPayload;
}
