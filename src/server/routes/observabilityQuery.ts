/**
 * Super-Admin Observability query router (TBI-007 / FEAT-005).
 * Mounted under /api/platform-admin after requireSuperAdmin.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { isEffortLevel, type EffortLevel } from '../../shared/types/effort';
import {
  OBSERVABILITY_VIEWER_FLAG,
  type ObservabilityTrendWindow,
} from '../../shared/types/observability';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getJourneyAggregationService } from '../services/journeyAggregationService';
import {
  generateObservabilityPoDigest,
  getObservabilityPoDigest,
  isObservabilityTrendWindow,
} from '../services/observabilityPoDigestService';
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

function parseOptionalTrendWindow(raw: unknown): ObservabilityTrendWindow | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  if (!isObservabilityTrendWindow(trimmed)) {
    throw new ObservabilityQueryError('OBSERVABILITY_INVALID_QUERY', 'Unsupported trend window');
  }
  return trimmed;
}

function parseOptionalEffort(raw: unknown): EffortLevel | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const trimmed = raw.trim();
  if (!isEffortLevel(trimmed)) {
    throw new ObservabilityQueryError('OBSERVABILITY_INVALID_QUERY', 'Invalid effort level');
  }
  return trimmed;
}

router.get('/po-digest', async (req: Request, res: Response): Promise<void> => {
  try {
    const query = queryRecord(req.query);
    const project = parseProjectParam(query);
    const window = parseOptionalTrendWindow(query.window);
    const model = typeof query.model === 'string' && query.model.trim() ? query.model.trim() : undefined;
    const effort = parseOptionalEffort(query.effort);
    const response = await getObservabilityPoDigest({
      project,
      window,
      model,
      effort,
    });
    res.status(200).json(response);
  } catch (err) {
    sendQueryError('po-digest', err, res);
  }
});

router.post('/po-digest/generate', async (req: Request, res: Response): Promise<void> => {
  try {
    const query = queryRecord(req.query);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const project =
      typeof body.project === 'string' && body.project.trim()
        ? body.project.trim()
        : parseProjectParam(query);
    const window = parseOptionalTrendWindow(body.window ?? query.window);
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
    const effort = parseOptionalEffort(body.effort);
    const slot =
      body.slot === 'morning_6am' || body.slot === 'evening_6pm' || body.slot === 'on_demand'
        ? body.slot
        : 'on_demand';

    const response = await generateObservabilityPoDigest({
      project,
      window,
      model,
      effort,
      slot,
    });
    res.status(200).json(response);
  } catch (err) {
    sendQueryError('po-digest-generate', err, res);
  }
});

export default router;
