import type { Request } from 'express';
import { prisma } from './db.js';

export async function audit(req: Request, action: string, objectType: string, objectId: string, metadata?: unknown) {
  await prisma.auditLog.create({
    data: {
      actorId: req.user?.id,
      action,
      objectType,
      objectId,
      metadata: metadata as object | undefined,
      ipAddress: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 500),
    },
  });
}
