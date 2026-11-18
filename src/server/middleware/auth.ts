import type { NextFunction, Request, Response } from 'express';
import { eq } from 'drizzle-orm';
import type { AuthContext, Role } from '../../shared/types.ts';
import { db } from '../db/index.ts';
import { apiKeys } from '../db/schema.ts';
import { hashApiKey } from '../utils/crypto.ts';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({
      error: {
        code: 'missing_api_key',
        message: 'Authorization Bearer access key is required.',
      },
    });
    return;
  }

  const keyHash = hashApiKey(token);
  const record = db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .get();

  if (!record || !record.isActive) {
    res.status(401).json({
      error: {
        code: 'invalid_api_key',
        message: 'The provided access key is invalid or revoked.',
      },
    });
    return;
  }

  const now = new Date().toISOString();
  db.update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, record.id))
    .run();

  req.auth = {
    keyId: record.id,
    workspaceId: record.workspaceId,
    departmentId: record.departmentId,
    userLabel: record.userLabel,
    keyPrefix: record.keyPrefix,
    role: record.role as Role,
    allowedAgentIds: record.allowedAgentIds ?? [],
  };

  next();
}

export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({
        error: { code: 'unauthenticated', message: 'Authentication required.' },
      });
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({
        error: {
          code: 'forbidden',
          message: `This action requires one of the following roles: ${allowedRoles.join(', ')}.`,
        },
      });
      return;
    }
    next();
  };
}
