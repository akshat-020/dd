import { createHash } from "node:crypto";
import { prisma } from "./prisma.js";

// Tamper-evident hash chain: each row's hash covers its own content plus
// the previous row's hash, so altering or deleting any row (even via
// direct DB access, not just through this API — no route anywhere updates
// or deletes an AuditLog row) breaks the chain from that point forward and
// can be detected by recomputing it, not just by "no API exists to do it."
function computeHash(previousHash: string | null, fields: { userId: string; action: string; entityType: string; entityId: string; before: string | null; after: string | null; createdAt: string }) {
  const payload = JSON.stringify({ previousHash, ...fields });
  return createHash("sha256").update(payload).digest("hex");
}

export async function recordAudit(params: {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}) {
  const last = await prisma.auditLog.findFirst({ orderBy: { createdAt: "desc" }, select: { hash: true } });
  const before = params.before === undefined ? null : JSON.stringify(params.before);
  const after = params.after === undefined ? null : JSON.stringify(params.after);
  const createdAt = new Date();

  const hash = computeHash(last?.hash ?? null, {
    userId: params.userId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    before,
    after,
    createdAt: createdAt.toISOString(),
  });

  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before,
      after,
      createdAt,
      previousHash: last?.hash ?? null,
      hash,
    },
  });
}

// Recomputes the chain from scratch and compares against stored hashes —
// returns the id of the first row where they diverge, or null if the whole
// log verifies clean. Used by the Owner-only audit-log verification check.
export async function verifyAuditChain(): Promise<{ valid: boolean; brokenAtId?: string }> {
  const rows = await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } });
  let previousHash: string | null = null;
  for (const row of rows) {
    const expected = computeHash(previousHash, {
      userId: row.userId,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      before: row.before,
      after: row.after,
      createdAt: row.createdAt.toISOString(),
    });
    if (expected !== row.hash || row.previousHash !== previousHash) {
      return { valid: false, brokenAtId: row.id };
    }
    previousHash = row.hash;
  }
  return { valid: true };
}
