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
import { acceptExternalPlaybookTrigger } from '../services/playbookWebhookService';

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

router.post('/playbooks/triggers/:publicId', async (req: Request, res: Response): Promise<void> => {
  const rawBody = (req as { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(400).json({ error: 'Raw body is required.' });
    return;
  }
  const result = await acceptExternalPlaybookTrigger({
    publicId: req.params.publicId,
    rawBody,
    signature: req.header('x-apex-signature'),
    deliveryId: req.header('x-apex-delivery'),
    authorization: req.header('authorization'),
    token: req.header('x-apex-token'),
  });
  res.status(result.status).json(result.body);
});

export default router;
