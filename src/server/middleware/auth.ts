import { Request, Response, NextFunction } from 'express';
import { enforceDevEnvironmentAccess } from './devEnvAccess';

export async function ensureAuthenticated(req: Request, res: Response, next: NextFunction): Promise<void> {
  console.log('Auth check:', {
    isAuthenticated: req.isAuthenticated(),
    sessionID: req.sessionID,
    user: req.user ? 'present' : 'missing'
  });

  if (!req.isAuthenticated()) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  try {
    const allowed = await enforceDevEnvironmentAccess(req, res);
    if (allowed) next();
  } catch (err) {
    next(err);
  }
}

export function getAuthUser(req: Request) {
  return req.user;
}
