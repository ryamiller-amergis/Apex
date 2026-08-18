/**
 * Authenticated browser ingest route.
 * Mounted at /api/observability behind ensureAuthenticated.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import express from 'express';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { getObservabilityIngestService } from '../services/observabilityIngestService';
import { INGEST_MAX_BYTES } from '../../shared/types/observability';

interface RawBodyRequest extends Request {
  rawBodyBytes?: number;
}

const router = Router();

router.post(
  '/events',
  express.json({
    limit: INGEST_MAX_BYTES,
    verify: (req: RawBodyRequest, _res, buf) => {
      req.rawBodyBytes = buf.length;
    },
  }),
  async (req: RawBodyRequest, res: Response): Promise<void> => {
    const actorUserId = getUserId(req);
    if (!actorUserId || actorUserId === 'anonymous') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawBodyBytes =
      req.rawBodyBytes ??
      (typeof req.body === 'string'
        ? Buffer.byteLength(req.body)
        : Buffer.byteLength(JSON.stringify(req.body ?? {})));

    const result = await getObservabilityIngestService().ingest({
      actorUserId,
      rawBodyBytes,
      body: req.body,
      isSuperAdmin: isSuperAdminRequest(req),
    });

    if (!('status' in result)) {
      res.status(202).json({ accepted: result.accepted });
      return;
    }

    if (result.status === 429) {
      res.setHeader('Retry-After', String(result.retryAfterSec ?? 1));
    }
    res.status(result.status).json({ error: result.error, code: result.code });
  },
);

router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  const error = err as { type?: string; status?: number; statusCode?: number };
  if (error?.type === 'entity.too.large' || error?.status === 413 || error?.statusCode === 413) {
    res.status(400).json({ error: 'Payload too large', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  next(err);
});

export default router;
