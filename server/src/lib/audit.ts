import { prisma } from "./prisma.js";

export async function recordAudit(params: {
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
}) {
  await prisma.auditLog.create({
    data: {
      userId: params.userId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before === undefined ? null : JSON.stringify(params.before),
      after: params.after === undefined ? null : JSON.stringify(params.after),
    },
  });
}
