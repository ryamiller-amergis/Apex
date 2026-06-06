import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getUserPermissions } from '../services/rbacService';
import { isSuperAdminRequest } from '../utils/superAdmin';

declare global {
  namespace Express {
    interface Request {
      _permissions?: Set<string>;
    }
  }
}

async function loadPermissions(req: Request): Promise<Set<string>> {
  if (req._permissions) return req._permissions;
  const userId = (req.user as any)?.profile?.oid;
  if (!userId) return new Set();
  const perms = await getUserPermissions(userId);
  req._permissions = perms;
  return perms;
}

export function requirePermission(...keys: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (isSuperAdminRequest(req)) {
      next();
      return;
    }
    const perms = await loadPermissions(req);
    const missing = keys.filter((k) => !perms.has(k));
    if (missing.length > 0) {
      res.status(403).json({ error: 'Forbidden', missing });
      return;
    }
    next();
  };
}

export function requireAnyPermission(...keys: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (isSuperAdminRequest(req)) {
      next();
      return;
    }
    const perms = await loadPermissions(req);
    const hasAny = keys.some((k) => perms.has(k));
    if (!hasAny) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}

export const requireSuperAdmin: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (!isSuperAdminRequest(req)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
};

export const attachPermissions: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    await loadPermissions(req);
  } catch {
    // intentionally swallowed — this middleware never blocks the request
  }
  next();
};
