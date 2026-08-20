/**
 * Session-free public API routes (FEAT-002 / PBI-003).
 *
 * Mount WITHOUT ensureAuthenticated, e.g.:
 *   app.use('/api/public', publicRoutes);
 *
 * Auth is requirePublicApiKey (Bearer API key). Project scope is derived solely
 * from the verified key — never from query, x-apex-project, or body.
 */
import { Router, type Request, type Response } from 'express';
import type { PublicPingResponse } from '../../shared/types/apiKey';
import { requirePublicApiKey } from '../middleware/publicApiKeyAuth';

const router = Router();

router.get('/ping', requirePublicApiKey, (req: Request, res: Response): void => {
  const ctx = req._publicApiKey;
  if (!ctx) {
    res.status(401).json({ error: 'Invalid or missing API key', code: 'PUBLIC_API_KEY_UNAUTHORIZED' });
    return;
  }

  const body: PublicPingResponse = {
    status: 'ok',
    projectId: ctx.projectId,
    timestamp: new Date().toISOString(),
  };
  res.status(200).json(body);
});

export default router;
