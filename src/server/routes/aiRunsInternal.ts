/**
 * Session-free internal ingest for the background AI runner (FEAT-004).
 *
 * Mount without ensureAuthenticated. Runner identity is enforced here and
 * project/run scope plus dispatch fencing are enforced by aiRunIngestService.
 */
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { requireAiRunnerAuth } from '../middleware/aiRunnerAuth';
import { db } from '../db/drizzle';
import { agentRuns, aiRunAttempts } from '../db/schema';
import {
  AiRunIngestError,
  getBootstrap,
  ingest,
} from '../services/aiRunIngestService';
import {
  InteractiveToolProxyTokenError,
  verifyInteractiveToolProxyToken,
} from '../services/interactiveToolProxyToken';
import {
  InteractiveToolProxyError,
  invokeInteractiveToolProxy,
} from '../services/interactiveToolProxyService';
import { isDurableInteractiveTurnSpecification } from '../../shared/types/durableInteractiveTurn';

const router = Router();

function handleServiceError(
  error: unknown,
  res: import('express').Response,
): boolean {
  if (!(error instanceof AiRunIngestError)) return false;

  const status =
    error.code === 'AI_RUN_DISPATCH_MISMATCH'
    || error.code === 'AI_RUN_ILLEGAL_TRANSITION'
      ? 409
      : error.code === 'AI_RUN_NOT_FOUND'
        ? 404
        : 422;
  res.status(status).json({ error: error.message, code: error.code });
  return true;
}

function extractBearerToken(header: unknown): string {
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

function localMcpUrl(
  serverName: 'ado-skills' | 'calendar-assistant' | 'maxview',
  descriptor: {
    profileId?: string;
    calendarSessionId?: string;
    enableRepoBrowse: boolean;
  },
): string {
  const port = process.env.PORT?.trim() || '3001';
  const base = `http://127.0.0.1:${port}`;
  switch (serverName) {
    case 'ado-skills': {
      const profilePath = descriptor.profileId
        ? `/grounding/${descriptor.profileId}`
        : '';
      const browse =
        descriptor.enableRepoBrowse === false ? '?enableRepoBrowse=false' : '';
      return `${base}/mcp/ado-skills${profilePath}${browse}`;
    }
    case 'calendar-assistant': {
      if (!descriptor.calendarSessionId) {
        throw new InteractiveToolProxyError(
          'calendar-assistant proxy requires calendarSessionId',
          400,
        );
      }
      return `${base}/mcp/calendar-assistant/${descriptor.calendarSessionId}`;
    }
    case 'maxview':
      return `${base}/mcp/maxview`;
    default: {
      const unhandled: never = serverName;
      throw new InteractiveToolProxyError(
        `Unsupported internal MCP server: ${String(unhandled)}`,
        400,
      );
    }
  }
}

router.get(
  '/:runId/bootstrap',
  requireAiRunnerAuth,
  async (req, res, next) => {
    try {
      const dispatchMessageId =
        typeof req.query.dispatchMessageId === 'string'
          ? req.query.dispatchMessageId
          : '';
      const result = await getBootstrap(req.params.runId, dispatchMessageId);
      res.status(200).json(result);
    } catch (error) {
      if (!handleServiceError(error, res)) next(error);
    }
  },
);

router.post(
  '/:projectId/:runId/ingest',
  requireAiRunnerAuth,
  async (req, res, next) => {
    try {
      const { projectId, runId } = req.params;
      const result = await ingest(projectId, runId, req.body);
      res.status(202).json({
        ok: true,
        cancelRequested: result.cancelRequested,
        run: result.run,
      });
    } catch (error) {
      if (!handleServiceError(error, res)) next(error);
    }
  },
);

/**
 * Signed interactive MCP proxy. Verifies token, expiry, path claims, active
 * attempt, and dispatch fence before invoking domain handlers. The HMAC token
 * is the auth (Cursor does not hold the runner callback token).
 */
router.post(
  '/:runId/tools/:serverName',
  async (req, res, next) => {
    try {
      const { runId, serverName } = req.params;
      const proxyTokenHeader = req.headers['x-interactive-tool-proxy-token'];
      const authHeader = req.headers.authorization;
      const resolvedToken =
        (typeof req.query.token === 'string' && req.query.token.trim()) ||
        (typeof proxyTokenHeader === 'string' && proxyTokenHeader.trim()) ||
        extractBearerToken(authHeader);
      const secret = process.env.SESSION_SECRET?.trim();
      if (!secret) {
        res.status(503).json({
          error: 'SESSION_SECRET is required',
          code: 'INTERACTIVE_V2_TOOL_PROXY_UNAVAILABLE',
        });
        return;
      }

      let claims;
      try {
        claims = verifyInteractiveToolProxyToken(
          resolvedToken,
          secret,
          new Date(),
        );
      } catch (error) {
        const message =
          error instanceof InteractiveToolProxyTokenError
            ? error.message
            : 'Invalid interactive tool proxy token';
        res.status(401).json({
          error: message,
          code: 'INTERACTIVE_V2_TOOL_PROXY_UNAUTHORIZED',
        });
        return;
      }

      if (claims.runId !== runId || claims.serverName !== serverName) {
        res.status(409).json({
          error: 'Tool proxy token claims do not match the path',
          code: 'AI_RUN_DISPATCH_MISMATCH',
        });
        return;
      }

      const [run] = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      if (!run || run.transportVersion !== 'dapr-actor-v2') {
        res.status(404).json({
          error: 'AI run not found',
          code: 'AI_RUN_NOT_FOUND',
        });
        return;
      }

      const [attempt] = await db
        .select()
        .from(aiRunAttempts)
        .where(
          and(
            eq(aiRunAttempts.id, claims.attemptId),
            eq(aiRunAttempts.runId, runId),
            eq(aiRunAttempts.dispatchMessageId, claims.dispatchMessageId),
          ),
        )
        .limit(1);
      if (!attempt || run.dispatchMessageId !== claims.dispatchMessageId) {
        res.status(409).json({
          error: 'Tool proxy fence does not match the active attempt',
          code: 'AI_RUN_DISPATCH_MISMATCH',
        });
        return;
      }
      if (
        attempt.status !== 'queued' &&
        attempt.status !== 'dispatched' &&
        attempt.status !== 'running'
      ) {
        res.status(409).json({
          error: 'Tool proxy requires an active attempt',
          code: 'AI_RUN_DISPATCH_MISMATCH',
        });
        return;
      }
      if (!isDurableInteractiveTurnSpecification(attempt.specSnapshot)) {
        res.status(422).json({
          error: 'Interactive attempt is missing a frozen specification',
          code: 'AI_RUN_VALIDATION',
        });
        return;
      }

      const result = await invokeInteractiveToolProxy({
        claims,
        specification: attempt.specSnapshot,
        body: req.body,
        invokeInternal: async (name, descriptor, body) => {
          const response = await fetch(localMcpUrl(name, descriptor), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          });
          const text = await response.text();
          let parsed: unknown = {};
          if (text) {
            try {
              parsed = JSON.parse(text);
            } catch {
              throw new InteractiveToolProxyError(
                'Internal MCP returned non-JSON',
                502,
              );
            }
          }
          if (!response.ok) {
            throw new InteractiveToolProxyError(
              `Internal MCP failed (${response.status})`,
              502,
            );
          }
          return parsed;
        },
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof InteractiveToolProxyError) {
        res.status(error.status).json({
          error: error.message,
          code: 'INTERACTIVE_V2_TOOL_PROXY_ERROR',
        });
        return;
      }
      if (!handleServiceError(error, res)) next(error);
    }
  },
);

export default router;
