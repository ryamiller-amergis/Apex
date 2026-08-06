/**
 * Foundation Skills authorization route — mounted under
 * /api/internal/foundation-skills WITHOUT ensureAuthenticated.
 *
 * The `@apex/skills` CLI runs on developer machines and in CI with no Apex
 * session, so it cannot reach the Platform Admin endpoints (Super Admin only).
 * This route is the one seam it needs.
 *
 * Unauthenticated by design, and safe to be so:
 *   - read-only; it can never mutate release, project, or repo state
 *   - the response contains no secrets — an Apex project name, a release
 *     version, and skill names that are already visible to any Apex user
 *   - it is not the security boundary. Reading the package still requires an
 *     Azure Artifacts token; this route only reports whether a repo is
 *     entitled, so a "yes" alone grants nothing.
 */

import { Router, Request, Response } from 'express';
import { authorizeSkillInstall } from '../services/foundationSkillAuthorizeService';

const router = Router();

/**
 * Must stay below the CLI's own 10s abort so a stalled lookup comes back as a
 * distinguishable 503 rather than as a client-side timeout, which the CLI would
 * otherwise report as "APEX unreachable" and send teams chasing VPN and URL
 * problems that do not exist.
 */
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 7000;

/** Read per-request so the budget can be retuned by restarting with a new env var. */
function authorizeTimeoutMs(): number {
  const raw = Number(process.env.FOUNDATION_SKILLS_AUTHORIZE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUTHORIZE_TIMEOUT_MS;
}

class AuthorizeTimeoutError extends Error {}

/**
 * Bounds how long the client waits. The underlying query is not cancellable, so
 * it may still complete after this rejects — acceptable because the lookup is
 * read-only and leaves nothing half-written.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AuthorizeTimeoutError(`authorization lookup exceeded ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err)   => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * GET /api/internal/foundation-skills/authorize?remote=<git remote url>
 *
 * Always 200 when `remote` is supplied — including for unauthorized repos — so
 * the CLI can distinguish a deliberate denial from an unreachable Apex.
 * 400 is reserved for a missing/blank parameter.
 */
router.get('/authorize', async (req: Request, res: Response): Promise<void> => {
  const remote = typeof req.query.remote === 'string' ? req.query.remote.trim() : '';
  const artifactVersion =
    typeof req.query.artifactVersion === 'string'
      ? req.query.artifactVersion.trim()
      : null;

  if (!remote) {
    res.status(400).json({ error: 'remote query param is required' });
    return;
  }

  const timeoutMs = authorizeTimeoutMs();

  try {
    const result = await withTimeout(
      authorizeSkillInstall(remote, artifactVersion || null),
      timeoutMs,
    );
    // Log the decision, never the raw remote — it can carry embedded credentials.
    console.log(
      `[foundation-skills-authorize] repo=${result.repo ?? 'unknown'} ` +
      `project=${result.apexProject ?? 'none'} reason=${result.reason}`,
    );
    res.json(result);
  } catch (err) {
    if (err instanceof AuthorizeTimeoutError) {
      console.error(`[foundation-skills-authorize] Timed out after ${timeoutMs}ms`);
      res.status(503).json({
        error: 'Authorization service is temporarily unavailable',
        code:  'authorization-unavailable',
      });
      return;
    }
    console.error('[foundation-skills-authorize] Failed:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Authorization check failed',
      code:  'authorization-failed',
    });
  }
});

export default router;
