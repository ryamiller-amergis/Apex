import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { requirePermission, requireProjectAccess, resolveRequestProject } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { isCanonicalUuid } from '../../shared/types/durableInteractiveTurn';
import {
  BRAINSTORM_CREATE,
  BRAINSTORM_MESSAGE_MAX_LENGTH,
  BRAINSTORM_VIEW,
} from '../../shared/types/brainstorm';
import { isBrainstormComposerMode } from '../../shared/types/brainstormArtifact';
import type { ChatAttachment } from '../../shared/types/chat';
import {
  decideBrainstormAccess,
  type BrainstormAccessDecision,
  type BrainstormAccessMode,
  type BrainstormViewer,
} from '../services/brainstormAccessPolicy';
import {
  isBrainstormEnabled,
  loadBrainstormSession,
  loadBrainstormViewer,
  type BrainstormSessionRow,
} from '../services/brainstormThread';
import { BrainstormError, brainstormSessionService } from '../services/brainstormSessionService';
import { brainstormOrchestrationService } from '../services/brainstormOrchestrationService';
import {
  listMessages,
  loadRunActivities,
  reconcileStreamingRows,
  toBrainstormMessageDto,
} from '../services/brainstormTurnLedger';
import { trackEvent } from '../services/telemetry';
import { buildBrainstormSourcesDeps, createBrainstormSourcesRouter } from './brainstormSources';
import { brainstormArtifactStore } from '../services/brainstormArtifactVersionStore';
import {
  createBrainstormArtifactRouter,
  defaultStartTypeSwitch,
  defaultTurnInProgress,
  sendArtifactError,
} from './brainstormArtifact';
import { createBrainstormHandoffsRouter } from './brainstormHandoffs';
import { createBrainstormRepositoriesRouter } from './brainstormRepositories';
import { brainstormHandoffEngine } from '../services/brainstormHandoffEngine';

interface BrainstormRequest extends Request {
  brainstorm?: {
    project: string;
    viewer: BrainstormViewer;
    session: BrainstormSessionRow;
    decision: BrainstormAccessDecision;
  };
}

const router = Router();

function requestProject(req: Request): string | undefined {
  return resolveRequestProject(req);
}

/** Every Brainstorm route returns 404 while the flag is off for the caller's project. */
const brainstormFlagGate: RequestHandler = async (req, res, next) => {
  const project = requestProject(req);
  if (!project) {
    res.status(400).json({ error: 'project is required' });
    return;
  }
  // @feature-flag:brainstorm start winner=enabled
  const enabled = await isBrainstormEnabled(getUserId(req), project);
  if (!enabled) {
    // @feature-flag:brainstorm disabled-start
    res.status(404).json({ error: 'Not found' });
    return;
    // @feature-flag:brainstorm disabled-end
  }
  // @feature-flag:brainstorm enabled-start
  next();
  // @feature-flag:brainstorm enabled-end
  // @feature-flag:brainstorm end
};

router.use(brainstormFlagGate);
router.use(createBrainstormRepositoriesRouter());

function refusalStatus(reason: string): number {
  switch (reason) {
    case 'not_found':
      return 404;
    case 'session_not_active':
      return 409;
    default:
      return 403;
  }
}

/** Loads the session within the request's project and applies the access policy. */
export function requireBrainstormSession(mode: BrainstormAccessMode): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = requestProject(req)!;
      const sessionId = req.params.id;
      const userId = getUserId(req);
      const viewer = await loadBrainstormViewer(userId, project, { isSuperAdmin: isSuperAdminRequest(req) });
      const session = isCanonicalUuid(sessionId) ? await loadBrainstormSession(sessionId, project) : null;
      const decision = decideBrainstormAccess({ viewer, project, session }, mode);
      if (decision.kind === 'refuse' || !session) {
        const reason = decision.kind === 'refuse' ? decision.reason : 'not_found';
        trackEvent('brainstorm.access.refused', { project, reason, mode });
        if (reason === 'not_found') {
          res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
        } else {
          const code = reason === 'not_creator'
            ? 'NOT_CREATOR'
            : reason === 'session_not_active'
              ? 'SESSION_NOT_ACTIVE'
              : 'FORBIDDEN';
          res.status(refusalStatus(reason)).json({ error: reason, code });
        }
        return;
      }
      (req as BrainstormRequest).brainstorm = { project, viewer, session, decision };
      next();
    } catch (err) {
      next(err);
    }
  };
}

function sendError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof BrainstormError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  const status = (err as { status?: number })?.status;
  if (status === 404) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  next(err);
}

function boundedInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

router.get(
  '/sessions',
  requirePermission(BRAINSTORM_VIEW),
  requireProjectAccess(requestProject),
  async (req, res, next) => {
    try {
      const project = requestProject(req)!;
      const viewer = await loadBrainstormViewer(getUserId(req), project, { isSuperAdmin: isSuperAdminRequest(req) });
      const result = await brainstormSessionService.listSessions({
        viewer,
        project,
        limit: Math.max(1, boundedInt(req.query.limit, 50, 200)),
        offset: boundedInt(req.query.offset, 0, Number.MAX_SAFE_INTEGER),
      });
      res.json(result);
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.post(
  '/sessions',
  requirePermission(BRAINSTORM_VIEW, BRAINSTORM_CREATE),
  requireProjectAccess(requestProject),
  async (req, res, next) => {
    try {
      const project = requestProject(req)!;
      const rawModel = (req.body as { model?: unknown } | undefined)?.model;
      if (rawModel !== undefined && typeof rawModel !== 'string') {
        res.status(400).json({ error: 'model must be a string' });
        return;
      }
      const viewer = await loadBrainstormViewer(getUserId(req), project, { isSuperAdmin: isSuperAdminRequest(req) });
      const session = await brainstormSessionService.createSession({ viewer, project, model: rawModel });
      res.status(201).json({ session });
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.get(
  '/sessions/:id',
  requirePermission(BRAINSTORM_VIEW),
  requireBrainstormSession('read'),
  async (req, res, next) => {
    try {
      const { viewer, session } = (req as BrainstormRequest).brainstorm!;
      res.json({ session: await brainstormSessionService.readSession({ viewer, session }) });
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.patch(
  '/sessions/:id',
  requirePermission(BRAINSTORM_VIEW),
  requireBrainstormSession('read'),
  async (req, res, next) => {
    try {
      const rawTitle = (req.body as { title?: unknown } | undefined)?.title;
      if (typeof rawTitle !== 'string' || !rawTitle.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const { project, viewer, session } = (req as BrainstormRequest).brainstorm!;
      const updated = await brainstormSessionService.renameSession({
        viewer,
        session,
        project,
        title: rawTitle,
      });
      res.json({ session: updated });
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.delete(
  '/sessions/:id',
  requirePermission(BRAINSTORM_VIEW),
  requireBrainstormSession('delete'),
  async (req, res, next) => {
    try {
      const { project, viewer, session } = (req as BrainstormRequest).brainstorm!;
      res.json(await brainstormSessionService.deleteSession({ viewer, session, project }));
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.get(
  '/sessions/:id/messages',
  requirePermission(BRAINSTORM_VIEW),
  requireBrainstormSession('read'),
  async (req, res, next) => {
    try {
      const { project, session } = (req as BrainstormRequest).brainstorm!;
      await reconcileStreamingRows(session.id, session.chatThreadId).catch(() => {});
      const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before))
        ? req.query.before
        : undefined;
      const rows = await listMessages({
        sessionId: session.id,
        project,
        limit: Math.max(1, boundedInt(req.query.limit, 200, 500)),
        before,
      });
      const activities = await loadRunActivities(
        rows
          .filter((row) => row.role === 'assistant' && row.runId)
          .map((row) => row.runId!),
      ).catch(() => new Map());
      res.json({
        messages: rows.map((row) =>
          toBrainstormMessageDto(row, row.runId ? activities.get(row.runId) : undefined),
        ),
      });
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

const MAX_CHAT_ATTACHMENTS = 5;
const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;

function parseBrainstormAttachments(raw: unknown): ChatAttachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error('attachments must be an array'), { status: 400 });
  }
  if (raw.length > MAX_CHAT_ATTACHMENTS) {
    throw Object.assign(new Error(`up to ${MAX_CHAT_ATTACHMENTS} attachments are allowed`), { status: 413 });
  }
  let totalBytes = 0;
  return raw.map((attachment, index) => {
    const a = attachment as Partial<ChatAttachment>;
    if (!a.id || !a.name || typeof a.content !== 'string') {
      throw Object.assign(new Error(`attachment ${index + 1} is invalid`), { status: 400 });
    }
    if (a.encoding !== undefined && a.encoding !== 'base64') {
      throw Object.assign(new Error(`attachment ${a.name} has an invalid encoding`), { status: 400 });
    }
    const size = Number(a.size);
    if (!Number.isFinite(size) || size < 0) {
      throw Object.assign(new Error(`attachment ${a.name} has an invalid size`), { status: 400 });
    }
    if (size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw Object.assign(new Error(`attachment ${a.name} is too large`), { status: 413 });
    }
    totalBytes += size;
    if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      throw Object.assign(new Error('attachments are too large'), { status: 413 });
    }
    return {
      id: a.id,
      name: a.name,
      type: a.type ?? 'text/plain',
      size,
      content: a.content,
      ...(a.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
    };
  });
}

router.post(
  '/sessions/:id/messages',
  requirePermission(BRAINSTORM_VIEW, BRAINSTORM_CREATE),
  requireBrainstormSession('mutate'),
  async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        turnId?: unknown;
        text?: unknown;
        model?: unknown;
        mode?: unknown;
        attachments?: unknown;
      };
      if (!isCanonicalUuid(body.turnId)) {
        res.status(400).json({ error: 'turnId must be a UUID' });
        return;
      }
      if (body.model !== undefined && typeof body.model !== 'string') {
        res.status(400).json({ error: 'model must be a string' });
        return;
      }
      if (body.mode !== undefined && !isBrainstormComposerMode(body.mode)) {
        res.status(400).json({ error: 'mode is invalid' });
        return;
      }
      let attachments: ChatAttachment[] = [];
      try {
        attachments = parseBrainstormAttachments(body.attachments);
      } catch (err) {
        const status = (err as { status?: number })?.status ?? 400;
        res.status(status).json({ error: (err as Error).message });
        return;
      }
      const rawText = typeof body.text === 'string' ? body.text : '';
      const effectiveText =
        rawText.trim() ||
        (attachments.length > 0 ? 'Please use the attached files as additional context.' : '');
      if (!effectiveText) {
        res.status(400).json({ error: 'text is required' });
        return;
      }
      if (effectiveText.length > BRAINSTORM_MESSAGE_MAX_LENGTH) {
        res.status(400).json({ error: 'text is too long' });
        return;
      }
      const { project, session } = (req as BrainstormRequest).brainstorm!;
      const userId = getUserId(req);
      const selectedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
      if (selectedModel && selectedModel !== session.model) {
        await brainstormSessionService.updateModelIfChanged(session.id, project, selectedModel, userId).catch(() => {});
      }
      const accepted = await brainstormOrchestrationService.runTurn({
        session,
        userId,
        turnId: body.turnId,
        text: effectiveText,
        model: selectedModel,
        mode: isBrainstormComposerMode(body.mode) ? body.mode : undefined,
        attachments,
      });
      res.status(202).json(accepted);
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.post(
  '/sessions/:id/cancel',
  requirePermission(BRAINSTORM_VIEW, BRAINSTORM_CREATE),
  requireBrainstormSession('mutate'),
  async (req, res, next) => {
    try {
      const { session } = (req as BrainstormRequest).brainstorm!;
      await brainstormOrchestrationService.cancel({ session });
      res.json({ ok: true });
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.post(
  '/sessions/:id/runs/:runId/retry',
  requirePermission(BRAINSTORM_VIEW, BRAINSTORM_CREATE),
  requireBrainstormSession('mutate'),
  async (req, res, next) => {
    try {
      const runId = req.params.runId;
      if (!isCanonicalUuid(runId)) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const { session } = (req as BrainstormRequest).brainstorm!;
      const accepted = await brainstormOrchestrationService.retryFailedTurn({
        session,
        userId: getUserId(req),
        runId,
      });
      res.status(202).json(accepted);
    } catch (err) {
      sendError(res, err, next);
    }
  },
);

router.use('/sessions/:id', createBrainstormSourcesRouter(buildBrainstormSourcesDeps({
  read: requireBrainstormSession('read'),
  mutate: requireBrainstormSession('mutate'),
})));

router.use('/sessions/:id', createBrainstormArtifactRouter({
  store: brainstormArtifactStore,
  turnInProgress: defaultTurnInProgress,
  startTypeSwitch: defaultStartTypeSwitch,
  read: requireBrainstormSession('read'),
  mutate: requireBrainstormSession('mutate'),
}));

router.use('/sessions/:id', createBrainstormHandoffsRouter({
  engine: brainstormHandoffEngine,
  read: requireBrainstormSession('read'),
  mutate: requireBrainstormSession('mutate'),
}));

/** Resolves the artifact's session in the request's project, then applies the session read policy. */
const resolveArtifactSession: RequestHandler = async (req, res, next) => {
  try {
    const artifactId = req.params.artifactId;
    const owner = isCanonicalUuid(artifactId) ? await brainstormArtifactStore.findArtifactById(artifactId) : null;
    if (!owner || owner.project !== requestProject(req)) {
      res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
      return;
    }
    req.params.id = owner.sessionId;
    next();
  } catch (err) {
    next(err);
  }
};

router.get(
  '/artifacts/:artifactId',
  requirePermission(BRAINSTORM_VIEW),
  resolveArtifactSession,
  requireBrainstormSession('read'),
  async (req, res, next) => {
    try {
      const { project, session } = (req as BrainstormRequest).brainstorm!;
      res.json({ artifact: await brainstormArtifactStore.getArtifact(session.id, project) });
    } catch (err) {
      sendArtifactError(res, err, next);
    }
  },
);

export default router;
