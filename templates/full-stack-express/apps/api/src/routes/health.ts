import {
  getHealthLive,
  getHealthReady,
  healthLiveSchema,
  healthReadySchema,
} from '@project-scope/contracts';
import express, { type Router } from 'express';
import type { ReadinessService } from '../services/readinessService.ts';
import { mountedAt } from './inventory.ts';

/**
 * Probes. Mounted before authentication and the rate-limit hook, so they need
 * no credentials and never return 401 or 429. Liveness has no dependencies.
 */
export function createHealthRouter(deps: {
  readiness: ReadinessService;
}): Router {
  const router = mountedAt(express.Router(), '');

  router.get(getHealthLive.path, (_req, res) => {
    res.json(healthLiveSchema.parse({ status: 'ok' }));
  });

  router.get(getHealthReady.path, async (_req, res) => {
    await deps.readiness.check();
    res.json(healthReadySchema.parse({ status: 'ready' }));
  });

  return router;
}
