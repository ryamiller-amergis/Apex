import express, { type NextFunction, type Request, type Response } from 'express';
import { BUILD_REVISION_FEEDBACK_MAX_LENGTH } from '../../shared/types/buildRevision';
import { BUILD_FROM_PROMPT_FLAG } from '../../shared/types/featureFlags';
import { requirePermission, requireProjectAccess, resolveRequestProject } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { defaultBuildDeploymentService } from '../services/buildDeploymentService';
import {
  BuildAcceptError,
  defaultBuildAcceptService,
} from '../services/build/buildAcceptService';
import {
  BuildRevisionError,
  defaultBuildRevisionService,
} from '../services/buildRevisionService';
import { isFeatureEnabled } from '../services/featureFlagService';
import { listBuildRepositories, listBuilds, normalizeListQuery } from '../services/buildQueryService';
import { refusalOf, startBuild } from '../services/buildOrchestrator/startBuild';
import { getBuildDetail, listBuildRunEvents, normalizeEventsLimit } from '../services/buildRunProjectionService';
import buildRunControlsRouter from './buildRunControls';
import buildVerificationRouter from './buildVerification';

const router = express.Router();

function copyProjectIdAlias(req: Request, _res: Response, next: NextFunction): void {
  const projectId = req.query.projectId;
  if ((typeof req.query.project !== 'string' || req.query.project.length === 0) && typeof projectId === 'string') {
    req.query.project = projectId;
  }
  next();
}

function requestProjectsDisagree(req: Request): boolean {
  const resolved = resolveRequestProject(req);
  const named = [
    req.query?.project,
    (req.body as { project?: unknown } | undefined)?.project,
    req.get?.('x-apex-project') ?? req.headers?.['x-apex-project'],
  ];
  return named.some((value) => typeof value === 'string' && value.length > 0 && value !== resolved);
}

router.use(copyProjectIdAlias);

router.use((req, res, next) => {
  if (requestProjectsDisagree(req)) {
    res.status(400).json({ error: 'The project in the query and the body do not match.', code: 'BAD_REQUEST' });
    return;
  }
  next();
});

const projectAccess = requireProjectAccess((req) => resolveRequestProject(req));

function requireBuildsProject(req: Request, res: Response, next: NextFunction): void {
  if (!resolveRequestProject(req)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

router.post(
  '/',
  projectAccess,
  requirePermission('builds:run', 'playbooks:run'),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId || userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const project = resolveRequestProject(req);
      if (!project) {
        res.status(400).json({ error: 'A project is required.', code: 'BAD_REQUEST' });
        return;
      }
      const body = req.body as {
        repository?: unknown;
        prompt?: unknown;
        model?: unknown;
        clientRequestId?: unknown;
      };
      const result = await startBuild({
        requesterUserId: userId,
        project,
        repository: typeof body.repository === 'string' ? body.repository : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        model: typeof body.model === 'string' ? body.model : undefined,
        clientRequestId: typeof body.clientRequestId === 'string' ? body.clientRequestId : '',
      });
      res.status(202).json(result);
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }
      next(error);
    }
  },
);

router.get(
  '/repositories',
  projectAccess,
  requirePermission('builds:run', 'playbooks:run'),
  async (req, res, next) => {
    try {
      const project = resolveRequestProject(req);
      if (!project) {
        res.status(400).json({ error: 'A project is required.', code: 'BAD_REQUEST' });
        return;
      }
      res.json({ repositories: await listBuildRepositories(project) });
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/',
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const project = resolveRequestProject(req);
      if (!project) {
        res.status(400).json({ error: 'A project is required.', code: 'BAD_REQUEST' });
        return;
      }
      const paging = normalizeListQuery(req.query);
      const result = await listBuilds({
        project,
        requesterUserId: getUserId(req),
        ...paging,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  },
);

/** Read routes stay open when `build-from-prompt` is off, so past builds remain viewable. */
router.get(
  '/:id',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const result = await getBuildDetail({ project: resolveRequestProject(req) as string, buildId: req.params.id });
      switch (result.kind) {
        case 'ok':
          res.json(result.detail);
          return;
        case 'wrong-project':
          res.status(403).json({ error: 'Forbidden' });
          return;
        case 'not-found':
          res.status(404).json({ error: 'Not found' });
          return;
        default: {
          const unhandled: never = result;
          throw new Error(`Unhandled detail result: ${JSON.stringify(unhandled)}`);
        }
      }
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  '/:id/events',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const result = await listBuildRunEvents({
        project: resolveRequestProject(req) as string,
        buildId: req.params.id,
        limit: normalizeEventsLimit(req.query.limit),
      });
      switch (result.kind) {
        case 'ok':
          res.json(result.response);
          return;
        case 'wrong-project':
          res.status(403).json({ error: 'Forbidden' });
          return;
        case 'not-found':
          res.status(404).json({ error: 'Not found' });
          return;
        default: {
          const unhandled: never = result;
          throw new Error(`Unhandled events result: ${JSON.stringify(unhandled)}`);
        }
      }
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/:id/retry-deployment',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId || userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const userPerms = (req as Request & { userPermissions?: Set<string> }).userPermissions;
      const isProjectAdmin = Boolean(userPerms?.has('admin:roles'));
      const isSuperAdmin = isSuperAdminRequest(req);

      const result = await defaultBuildDeploymentService.retryDeployment({
        buildRunId: req.params.id,
        actor: {
          userId,
          isProjectAdmin,
          isSuperAdmin,
        },
      });

      switch (result.kind) {
        case 'ok':
          res.status(202).json(result.response);
          return;
        case 'forbidden':
          res.status(403).json({ error: 'Forbidden' });
          return;
        case 'not_found':
          res.status(404).json({ error: 'Not found' });
          return;
        case 'not_retryable':
          res.status(409).json({
            error: result.message,
            code: 'BUILD_NOT_RETRYABLE',
          });
          return;
        default: {
          const exhaustive: never = result;
          throw new Error(`Unhandled retry result: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  '/:id/revisions',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:run'),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId || userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const project = resolveRequestProject(req) as string;

      // @feature-flag:build-from-prompt start winner=enabled
      const flagOn = await isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, {
        userId,
        project,
      });
      if (!flagOn) {
        // @feature-flag:build-from-prompt disabled-start
        res.status(403).json({
          error: 'Builds are switched off for this project right now. Your past builds stay readable.',
          code: 'BUILDS_DISABLED',
        });
        return;
        // @feature-flag:build-from-prompt disabled-end
      }
      // @feature-flag:build-from-prompt enabled-start
      const userPerms = (req as Request & { userPermissions?: Set<string> }).userPermissions;
      const isProjectAdmin = Boolean(userPerms?.has('admin:roles'));
      const isSuperAdmin = isSuperAdminRequest(req);
      const body = req.body as { feedback?: unknown } | undefined;
      const feedback = typeof body?.feedback === 'string' ? body.feedback : '';
      const trimmedFeedback = feedback.trim();
      if (!trimmedFeedback) {
        res.status(400).json({
          error: 'Describe what you want changed.',
          code: 'FEEDBACK_REQUIRED',
        });
        return;
      }
      if (trimmedFeedback.length > BUILD_REVISION_FEEDBACK_MAX_LENGTH) {
        res.status(400).json({
          error: 'Use 4,000 characters or fewer.',
          code: 'FEEDBACK_TOO_LONG',
        });
        return;
      }

      const accepted = await defaultBuildRevisionService.requestRevision({
        buildId: req.params.id,
        project,
        feedback,
        actor: {
          userId,
          isProjectAdmin,
          isSuperAdmin,
        },
      });
      res.status(202).json(accepted);
      // @feature-flag:build-from-prompt enabled-end
      // @feature-flag:build-from-prompt end
    } catch (error) {
      if (error instanceof BuildRevisionError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      next(error);
    }
  },
);

router.post(
  '/:id/accept',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:run'),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      if (!userId || userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const project = resolveRequestProject(req) as string;

      // @feature-flag:build-from-prompt start winner=enabled
      const flagOn = await isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, {
        userId,
        project,
      });
      if (!flagOn) {
        // @feature-flag:build-from-prompt disabled-start
        res.status(403).json({
          error: 'Build from prompt is turned off for this project.',
          code: 'BUILD_FLAG_DISABLED',
        });
        return;
        // @feature-flag:build-from-prompt disabled-end
      }
      // @feature-flag:build-from-prompt enabled-start
      const userPerms = (req as Request & { userPermissions?: Set<string> }).userPermissions;
      const isProjectAdmin = Boolean(userPerms?.has('admin:roles'));
      const isSuperAdmin = isSuperAdminRequest(req);
      const body = req.body as { revisionNumber?: unknown } | undefined;
      const revisionNumber =
        typeof body?.revisionNumber === 'number' ? body.revisionNumber : NaN;

      const result = await defaultBuildAcceptService.acceptBuild({
        buildId: req.params.id,
        project,
        revisionNumber,
        actor: {
          userId,
          isProjectAdmin,
          isSuperAdmin,
        },
      });

      if (result.firstClaim) {
        void defaultBuildAcceptService.continueAccept(req.params.id);
        res.status(202).json(result.response);
        return;
      }
      res.status(200).json(result.response);
      // @feature-flag:build-from-prompt enabled-end
      // @feature-flag:build-from-prompt end
    } catch (error) {
      if (error instanceof BuildAcceptError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      next(error);
    }
  },
);

router.use(buildRunControlsRouter);
router.use(buildVerificationRouter);

export default router;
