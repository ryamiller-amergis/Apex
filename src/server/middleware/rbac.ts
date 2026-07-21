import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getUserPermissions } from '../services/rbacService';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { getUserGroupNames } from '../services/groupService';
import { getAssignmentsForUser } from '../services/userProjectAssignmentService';

declare global {
  // Express request augmentation requires the namespace form.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      _permissions?: Set<string>;
    }
  }
}

export function resolveRequestProject(req: Request): string | undefined {
  const fromQuery = req.query?.project;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;

  const fromParams = req.params?.project;
  if (typeof fromParams === 'string' && fromParams) return fromParams;

  const fromBody = (req.body as Record<string, unknown> | undefined)?.project;
  if (typeof fromBody === 'string' && fromBody) return fromBody;

  const fromHeader = req.get?.('x-apex-project') ?? req.headers?.['x-apex-project'];
  if (typeof fromHeader === 'string' && fromHeader) return fromHeader;

  return undefined;
}

async function loadPermissions(req: Request): Promise<Set<string>> {
  if (req._permissions) return req._permissions;
  const userId = (req.user as any)?.profile?.oid;
  if (!userId) return new Set();
  const project = resolveRequestProject(req);
  const perms = await getUserPermissions(userId, project);
  req._permissions = perms;
  return perms;
}

export function requirePermission(...keys: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
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
    } catch (err) {
      next(err);
    }
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

export function requireGroupMembership(...groupNames: string[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (isSuperAdminRequest(req)) {
        next();
        return;
      }
      const userId = (req.user as any)?.profile?.oid as string | undefined;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      // Admins (users with admin:roles permission) bypass the group check
      const perms = await loadPermissions(req);
      if (perms.has('admin:roles')) {
        next();
        return;
      }
      const userGroups = await getUserGroupNames(userId);
      if (groupNames.some(g => userGroups.includes(g))) {
        next();
        return;
      }
      res.status(403).json({ error: 'Forbidden', requiredGroups: groupNames });
    } catch (err) {
      next(err);
    }
  };
}

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

/**
 * Middleware factory that enforces per-project access.
 * Super admins bypass. All others must have the requested project in their
 * user_project_assignments. Pass `project=all` to get data across all
 * assigned projects (only super admins receive every project).
 *
 * @param resolveProject - extracts the project string from the request (query / param / body).
 */
export function requireProjectAccess(
  resolveProject: (req: Request) => string | undefined,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (isSuperAdminRequest(req)) {
        next();
        return;
      }
      const project = resolveProject(req);
      // "all" is a super-admin-only sentinel — regular users may not use it
      if (!project || project === 'all') {
        res.status(403).json({ error: 'Forbidden: project parameter required' });
        return;
      }
      const userId = (req.user as any)?.profile?.oid as string | undefined;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const assigned = await getAssignmentsForUser(userId);
      if (!assigned.includes(project)) {
        res.status(403).json({ error: 'Forbidden: not assigned to this project' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
