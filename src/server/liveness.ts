import type { Request, Response } from 'express';

/**
 * Azure App Service Health Check path. Must stay in sync with
 * `local.app_health_check_path` in infra/main.tf.
 *
 * Intentionally does no I/O: a hung event loop fails the probe and drains
 * the instance. ADO/Postgres outages must not take every worker out of rotation.
 */
export const LIVENESS_PATH = '/api/health/live';

export function sendLiveness(_req: Request, res: Response): void {
  res.status(200).json({ ok: true });
}
