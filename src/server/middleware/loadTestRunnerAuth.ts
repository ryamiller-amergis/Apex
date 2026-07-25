/**
 * Runner callback auth for load-test ingest (FEAT-007 / A-009 / PBI-009 AC-1).
 * Human session RBAC is NOT a substitute for callback identity.
 */
import type { Request, Response, NextFunction } from 'express';

export const LOAD_TEST_RUNNER_AUTH_HEADER = 'authorization';

/**
 * Validates Authorization: Bearer <LT_RUNNER_CALLBACK_TOKEN>.
 * In test/dev, LT_RUNNER_CALLBACK_TOKEN may be set explicitly.
 */
export function requireLoadTestRunnerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.LT_RUNNER_CALLBACK_TOKEN?.trim();
  if (!expected) {
    res.status(503).json({
      error: 'Load-test runner callback auth is not configured',
      code: 'LOAD_TEST_RUNNER_AUTH_UNCONFIGURED',
    });
    return;
  }

  const header = req.header(LOAD_TEST_RUNNER_AUTH_HEADER) || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();

  if (!token || token !== expected) {
    res.status(401).json({
      error: 'Invalid load-test runner identity',
      code: 'LOAD_TEST_RUNNER_UNAUTHORIZED',
    });
    return;
  }

  next();
}
