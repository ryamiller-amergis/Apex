/**
 * Super-Admin Observability query router (TBI-007 / FEAT-005).
 * Mounted under /api/platform-admin after requireSuperAdmin.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { OBSERVABILITY_VIEWER_FLAG } from '../../shared/types/observability';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getJourneyAggregationService } from '../services/journeyAggregationService';
import * as observabilityQueryService from '../services/observabilityQueryService';
import {
  ObservabilityQueryError,
  parseJourneyQuery,
  parseProjectParam,
  parseSessionOverlayQuery,
  parseSessionTimelineQuery,
  parseTraceQuery,
  parseUserTrailQuery,
} from '../services/observabilityQueryValidation';
import { ObservabilityTimelineUnavailableError } from '../services/observabilityQueryValidation';
import { getUserId } from '../utils/requestUser';

const router = Router();

function queryRecord(value: Request['query'] | Request['params']): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function logQueryFailure(kind: string, code: string): void {
  console.error('observability query failed', { kind, code });
}

function sendQueryError(kind: string, err: unknown, res: Response): void {
  if (err instanceof ObservabilityQueryError) {
    logQueryFailure(kind, err.code);
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  logQueryFailure(kind, 'INTERNAL');
  res.status(500).json({ error: 'Internal server error' });
}

async function requireObservabilityViewer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const project = parseProjectParam(queryRecord(req.query));
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled(OBSERVABILITY_VIEWER_FLAG, { userId, project });

    // @feature-flag:observability-viewer start winner=enabled
    if (!enabled) {
      // @feature-flag:observability-viewer disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:observability-viewer disabled-end
    }

    // @feature-flag:observability-viewer enabled-start
    next();
    // @feature-flag:observability-viewer enabled-end
    // @feature-flag:observability-viewer end
  } catch (err) {
    sendQueryError('flag', err, res);
  }
}

router.use(requireObservabilityViewer);

router.get('/trail', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters = parseUserTrailQuery(queryRecord(req.query));
    const page = await observabilityQueryService.queryUserTrail(filters);
    res.status(200).json(page);
  } catch (err) {
    sendQueryError('trail', err, res);
  }
});

router.get('/traces/:traceId', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters = parseTraceQuery(queryRecord(req.params), queryRecord(req.query));
    const page = await observabilityQueryService.queryTrace(filters);
    if (!page) {
      res.status(404).json({ error: 'Not found', code: 'OBSERVABILITY_NOT_FOUND' });
      return;
    }
    res.status(200).json(page);
  } catch (err) {
    sendQueryError('trace', err, res);
  }
});

router.get('/session-overlays/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters = parseSessionOverlayQuery(queryRecord(req.params), queryRecord(req.query));
    const page = await observabilityQueryService.querySessionOverlay(filters);
    if (!page) {
      res.status(404).json({ error: 'Not found', code: 'OBSERVABILITY_NOT_FOUND' });
      return;
    }
    res.status(200).json(page);
  } catch (err) {
    sendQueryError('session', err, res);
  }
});

router.get('/sessions/:sessionId/timeline', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters = parseSessionTimelineQuery(queryRecord(req.params), queryRecord(req.query));
    const page = await observabilityQueryService.getSessionTimeline(filters);
    res.status(200).json(page);
  } catch (err) {
    if (err instanceof ObservabilityTimelineUnavailableError) {
      logQueryFailure('timeline', 'UNAVAILABLE');
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
    sendQueryError('timeline', err, res);
  }
});

router.get('/journeys', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters = parseJourneyQuery(queryRecord(req.query));
    const page = await observabilityQueryService.queryJourneyMap(filters);
    res.status(200).json(page);
  } catch (err) {
    sendQueryError('journey', err, res);
  }
});

router.post('/journeys/reconcile', async (req: Request, res: Response): Promise<void> => {
  try {
    const filters = parseJourneyQuery(queryRecord(req.query));
    const result = await getJourneyAggregationService().reconcileJourneyDays(filters.fromDay, filters.toDay);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    sendQueryError('journey', err, res);
  }
});

router.get('/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    const snapshot = await observabilityQueryService.getCaptureHealth();
    res.status(200).json(snapshot);
  } catch (err) {
    sendQueryError('health', err, res);
  }
});

export default router;
