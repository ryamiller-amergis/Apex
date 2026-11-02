/**
 * FEAT-003 — artifact, version and type routes for one Brainstorm session.
 *
 * Mounted under `/api/brainstorm/sessions/:id`; `read` and `mutate` are the
 * session access handlers from `brainstorm.ts`, so this router never decides access.
 */
import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { BRAINSTORM_CREATE, BRAINSTORM_VIEW } from '../../shared/types/brainstorm';
import {
  BRAINSTORM_ARTIFACT_TYPE_LABELS,
  BRAINSTORM_ARTIFACT_TYPES,
  type BrainstormArtifactType,
  type BrainstormTypeSwitchAcceptedDto,
} from '../../shared/types/brainstormArtifact';
import { BrainstormArtifactError, type ArtifactVersionStore } from '../services/brainstormArtifactVersionStore';
import type { BrainstormSessionRow } from '../services/brainstormThread';
import { BrainstormError } from '../services/brainstormSessionService';

/** The visible chat message a type-switch turn posts for the creator. */
export function typeSwitchMessage(targetType: BrainstormArtifactType): string {
  return `Switch the artifact type to ${BRAINSTORM_ARTIFACT_TYPE_LABELS[targetType]}.`;
}

export interface BrainstormArtifactRouteDeps {
  store: Pick<
    ArtifactVersionStore,
    | 'getArtifact'
    | 'listVersions'
    | 'getVersion'
    | 'compareVersions'
    | 'labelCheckpoint'
    | 'rollback'
    | 'setTypeOnEmpty'
  >;
  /** True while the session's latest collaborator reply is still streaming. */
  turnInProgress: (sessionId: string) => Promise<boolean>;
  startTypeSwitch: (input: {
    session: BrainstormSessionRow;
    userId: string;
    targetType: BrainstormArtifactType;
  }) => Promise<BrainstormTypeSwitchAcceptedDto>;
  read: RequestHandler;
  mutate: RequestHandler;
}

interface SessionRequest {
  brainstorm?: { project: string; session: BrainstormSessionRow };
}

const expectedVersion = z.number().int().min(0);
const checkpointBody = z.object({ name: z.unknown(), expectedVersion });
const rollbackBody = z.object({ toSequence: z.number().int().min(1), expectedVersion });
const typeBody = z.object({ type: z.unknown(), expectedVersion });

function sessionOf(req: unknown): { project: string; session: BrainstormSessionRow } {
  return (req as SessionRequest).brainstorm!;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function sendArtifactError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof BrainstormArtifactError) {
    res.status(err.status).json({ error: err.code, code: err.code, ...err.details });
    return;
  }
  if (err instanceof BrainstormError) {
    const code = err.code === 'turn_in_progress' ? 'TURN_IN_PROGRESS' : err.code;
    res.status(err.status).json({ error: err.code, code });
    return;
  }
  next(err);
}

function invalid(res: Response, code = 'INVALID_REQUEST'): void {
  res.status(400).json({ error: code, code });
}

export function createBrainstormArtifactRouter(deps: BrainstormArtifactRouteDeps): Router {
  const router = Router({ mergeParams: true });
  const view = requirePermission(BRAINSTORM_VIEW);
  const create = requirePermission(BRAINSTORM_VIEW, BRAINSTORM_CREATE);

  router.get('/artifact', view, deps.read, async (req, res, next) => {
    try {
      const { project, session } = sessionOf(req);
      res.json({ artifact: await deps.store.getArtifact(session.id, project) });
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  });

  router.get('/artifact/versions', view, deps.read, async (req, res, next) => {
    try {
      const { project, session } = sessionOf(req);
      const limit = positiveInt(req.query.limit) ?? 50;
      const cursor = positiveInt(req.query.cursor);
      res.json(await deps.store.listVersions(session.id, project, { limit, cursor }));
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  });

  router.get('/artifact/versions/:sequence', view, deps.read, async (req, res, next) => {
    try {
      const sequence = positiveInt(req.params.sequence);
      if (sequence === null) {
        res.status(404).json({ error: 'VERSION_NOT_FOUND', code: 'VERSION_NOT_FOUND' });
        return;
      }
      const { project, session } = sessionOf(req);
      res.json({ version: await deps.store.getVersion(session.id, project, sequence) });
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  });

  router.get('/artifact/compare', view, deps.read, async (req, res, next) => {
    try {
      const from = positiveInt(req.query.from);
      const to = positiveInt(req.query.to);
      if (from === null || to === null) {
        invalid(res);
        return;
      }
      const { project, session } = sessionOf(req);
      res.json(await deps.store.compareVersions(session.id, project, from, to));
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  });

  router.post('/artifact/checkpoints', create, deps.mutate, async (req, res, next) => {
    try {
      const body = checkpointBody.safeParse(req.body ?? {});
      if (!body.success) {
        invalid(res);
        return;
      }
      const { project, session } = sessionOf(req);
      const version = await deps.store.labelCheckpoint({
        sessionId: session.id,
        project,
        authorId: getUserId(req),
        expectedVersion: body.data.expectedVersion,
        name: body.data.name,
      });
      res.status(201).json({ version });
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  });

  router.post('/artifact/rollback', create, deps.mutate, async (req, res, next) => {
    try {
      const body = rollbackBody.safeParse(req.body ?? {});
      if (!body.success) {
        invalid(res);
        return;
      }
      const { project, session } = sessionOf(req);
      if (await deps.turnInProgress(session.id)) {
        res.status(409).json({ error: 'TURN_IN_PROGRESS', code: 'TURN_IN_PROGRESS' });
        return;
      }
      const version = await deps.store.rollback({
        sessionId: session.id,
        project,
        authorId: getUserId(req),
        expectedVersion: body.data.expectedVersion,
        toSequence: body.data.toSequence,
      });
      res.status(201).json({ version });
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  });

  router.post('/artifact/type', create, deps.mutate, async (req, res, next) => {
    try {
      const body = typeBody.safeParse(req.body ?? {});
      if (!body.success) {
        invalid(res);
        return;
      }
      const type = body.data.type;
      if (typeof type !== 'string' || !(BRAINSTORM_ARTIFACT_TYPES as readonly string[]).includes(type)) {
        invalid(res, 'INVALID_ARTIFACT_TYPE');
        return;
      }
      const targetType = type as BrainstormArtifactType;
      const { project, session } = sessionOf(req);
      const userId = getUserId(req);
      if (await deps.turnInProgress(session.id)) {
        res.status(409).json({ error: 'TURN_IN_PROGRESS', code: 'TURN_IN_PROGRESS' });
        return;
      }
      const current = await deps.store.getArtifact(session.id, project);
      if (current.version !== body.data.expectedVersion) {
        res.status(409).json({
          error: 'ARTIFACT_VERSION_CONFLICT',
          code: 'ARTIFACT_VERSION_CONFLICT',
          currentVersion: current.version,
        });
        return;
      }
      if (current.type === targetType) {
        invalid(res, 'INVALID_ARTIFACT_TYPE');
        return;
      }
      if (current.markdown.trim().length === 0) {
        const version = await deps.store.setTypeOnEmpty({
          sessionId: session.id,
          project,
          authorId: userId,
          expectedVersion: current.version,
          type: targetType,
        });
        res.status(200).json({ version });
        return;
      }
      res.status(202).json(await deps.startTypeSwitch({ session, userId, targetType }));
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  });

  return router;
}

/** Production wiring for the artifact router. */
export async function defaultStartTypeSwitch(input: {
  session: BrainstormSessionRow;
  userId: string;
  targetType: BrainstormArtifactType;
}): Promise<BrainstormTypeSwitchAcceptedDto> {
  const { brainstormOrchestrationService } = await import('../services/brainstormOrchestrationService');
  const accepted = await brainstormOrchestrationService.runTurn({
    session: input.session,
    userId: input.userId,
    turnId: randomUUID(),
    text: typeSwitchMessage(input.targetType),
    intent: { kind: 'type_switch', targetType: input.targetType },
  });
  return { turnId: accepted.turnId, runId: accepted.runId, messageId: accepted.messageId };
}

export async function defaultTurnInProgress(sessionId: string): Promise<boolean> {
  const { latestAssistantRow } = await import('../services/brainstormTurnLedger');
  const latest = await latestAssistantRow(sessionId);
  return latest?.status === 'streaming';
}
