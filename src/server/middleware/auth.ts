import { Request, Response, NextFunction } from 'express';

export function ensureAuthenticated(req: Request, res: Response, next: NextFunction) {
  console.log('Auth check:', {
    isAuthenticated: req.isAuthenticated(),
    sessionID: req.sessionID,
    user: req.user ? 'present' : 'missing'
  });
  
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
  return;
}

export function getAuthUser(req: Request) {
  return req.user;
}
