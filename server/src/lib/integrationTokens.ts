import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { prisma } from "./prisma.js";

// Machine-to-machine access for the call desk's telephony/automation layer
// (docs/call-desk/COMBINED_PLAN.md, gap G2). User logins can't serve this:
// sessions expire after inactivity and carry a person's full permissions.
// An integration token is long-lived but narrowly scoped, stored only as a
// SHA-256 hash, and revocable by the Owner at any time.
export const INTEGRATION_SCOPES = ["party.lookup"] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

export const INTEGRATION_TOKEN_HEADER = "x-integration-token";
const TOKEN_PREFIX = "oms_int_";

export function hashIntegrationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateIntegrationToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export interface IntegrationRequest extends Request {
  integration?: { tokenId: string; name: string };
}

export function requireIntegrationToken(scope: IntegrationScope) {
  return async (req: IntegrationRequest, res: Response, next: NextFunction) => {
    const token = req.header(INTEGRATION_TOKEN_HEADER);
    if (!token || !token.startsWith(TOKEN_PREFIX)) {
      return res.status(401).json({ error: "Missing integration token" });
    }
    try {
      const row = await prisma.integrationToken.findUnique({ where: { tokenHash: hashIntegrationToken(token) } });
      if (!row || row.revokedAt) return res.status(401).json({ error: "Invalid or revoked integration token" });
      if (!row.scopes.split(",").includes(scope)) {
        return res.status(403).json({ error: `Integration token lacks the "${scope}" scope` });
      }
      req.integration = { tokenId: row.id, name: row.name };
      // Not awaited: this endpoint sits on a live call's routing path, so
      // bookkeeping must never add latency or fail the lookup.
      prisma.integrationToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch((err) => console.error(err));
      next();
    } catch (err) {
      next(err);
    }
  };
}
