import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { BUILD_REVISION_FEEDBACK_MAX_LENGTH } from '../../shared/types/buildRevision';
import { isLogoReviewRequest } from '../../shared/buildLogoReview';
import { BUILD_FROM_PROMPT_FLAG } from '../../shared/types/featureFlags';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { defaultBuildDeploymentService } from '../services/buildDeploymentService';
import {
  BuildAcceptError,
  defaultBuildAcceptService,
} from '../services/build/buildAcceptService';
import { defaultBuildLocalPreviewLaunchService } from '../services/build/buildLocalPreviewLaunchService';
import {
  BuildRevisionError,
  defaultBuildRevisionService,
} from '../services/buildRevisionService';
import {
  BuildLogoCandidateError,
  defaultBuildLogoCandidateService,
} from '../services/build/buildLogoCandidateService';
import {
  DesignPreferenceProfileError,
  proposeFromBuildFeedback,
} from '../services/designPreferenceProfileService';
import { isFeatureEnabled } from '../services/featureFlagService';
import {
  listBuildRepositories,
  listBuilds,
  normalizeListQuery,
} from '../services/buildQueryService';
import {
  refusalOf,
  startBuild,
} from '../services/buildOrchestrator/startBuild';
import {
  confirmAndStartPlanning,
  driveBuildOrchestration,
  getActiveBuildAgentSummary,
} from '../services/buildOrchestrator/planning';
import { loadBuild } from '../services/buildOrchestrator/store';
import {
  getBuildDetail,
  listBuildRunEvents,
  normalizeEventsLimit,
} from '../services/buildRunProjectionService';
import buildRunControlsRouter from './buildRunControls';
import buildVerificationRouter from './buildVerification';

const router = express.Router();

function copyProjectIdAlias(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const projectId = req.query.projectId;
  if (
    (typeof req.query.project !== 'string' || req.query.project.length === 0) &&
    typeof projectId === 'string'
  ) {
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
  return named.some(
    (value) =>
      typeof value === 'string' && value.length > 0 && value !== resolved
  );
}

router.use(copyProjectIdAlias);

router.use((req, res, next) => {
  if (requestProjectsDisagree(req)) {
    res.status(400).json({
      error: 'The project in the query and the body do not match.',
      code: 'BAD_REQUEST',
    });
    return;
  }
  next();
});

const projectAccess = requireProjectAccess((req) => resolveRequestProject(req));

function requireBuildsProject(
  req: Request,
  res: Response,
  next: NextFunction
): void {
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
        res
          .status(400)
          .json({ error: 'A project is required.', code: 'BAD_REQUEST' });
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
        clientRequestId:
          typeof body.clientRequestId === 'string' ? body.clientRequestId : '',
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
  }
);

router.get(
  '/repositories',
  projectAccess,
  requirePermission('builds:run', 'playbooks:run'),
  async (req, res, next) => {
    try {
      const project = resolveRequestProject(req);
      if (!project) {
        res
          .status(400)
          .json({ error: 'A project is required.', code: 'BAD_REQUEST' });
        return;
      }
      res.json({ repositories: await listBuildRepositories(project) });
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  '/',
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const project = resolveRequestProject(req);
      if (!project) {
        res
          .status(400)
          .json({ error: 'A project is required.', code: 'BAD_REQUEST' });
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
  }
);

/** Read routes stay open when `build-from-prompt` is off, so past builds remain viewable. */
router.get(
  '/:id',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const userId = getUserId(req);
      const userPerms = (req as Request & { userPermissions?: Set<string> })
        .userPermissions;
      const result = await getBuildDetail({
        project: resolveRequestProject(req) as string,
        buildId: req.params.id,
        viewer:
          userId && userId !== 'anonymous'
            ? {
                userId,
                isProjectAdmin: Boolean(userPerms?.has('admin:roles')),
                isSuperAdmin: isSuperAdminRequest(req),
              }
            : undefined,
      });
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
          throw new Error(
            `Unhandled detail result: ${JSON.stringify(unhandled)}`
          );
        }
      }
    } catch (error) {
      next(error);
    }
  }
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
          throw new Error(
            `Unhandled events result: ${JSON.stringify(unhandled)}`
          );
        }
      }
    } catch (error) {
      next(error);
    }
  }
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
      const userPerms = (req as Request & { userPermissions?: Set<string> })
        .userPermissions;
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
          throw new Error(
            `Unhandled retry result: ${JSON.stringify(exhaustive)}`
          );
        }
      }
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/local-preview',
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
      const userPerms = (req as Request & { userPermissions?: Set<string> })
        .userPermissions;
      const result = await defaultBuildLocalPreviewLaunchService.start({
        buildRunId: req.params.id,
        project: resolveRequestProject(req) as string,
        actor: {
          userId,
          isProjectAdmin: Boolean(userPerms?.has('admin:roles')),
          isSuperAdmin: isSuperAdminRequest(req),
        },
      });

      switch (result.kind) {
        case 'started':
          res.status(202).json({
            status: 'started',
            revisionNumber: result.revisionNumber,
          });
          return;
        case 'unavailable':
          res.status(404).json({
            error:
              'Local previews are available only from a local Apex server.',
            code: 'LOCAL_PREVIEW_UNAVAILABLE',
          });
          return;
        case 'not_found':
          res.status(404).json({
            error: 'Build not found.',
            code: 'LOCAL_PREVIEW_NOT_FOUND',
          });
          return;
        case 'forbidden':
          res.status(403).json({
            error: 'You cannot start a local preview for this build.',
            code: 'LOCAL_PREVIEW_FORBIDDEN',
          });
          return;
        case 'not_ready':
          res.status(409).json({
            error: result.message,
            code: 'LOCAL_PREVIEW_NOT_READY',
          });
          return;
        case 'already_active':
          res.status(409).json({
            error: 'This revision already has an active local preview.',
            code: 'LOCAL_PREVIEW_ALREADY_ACTIVE',
          });
          return;
        case 'busy':
          res.status(409).json({
            error: 'Another preview is using this project repository.',
            code: 'LOCAL_PREVIEW_BUSY',
          });
          return;
        default: {
          const exhaustive: never = result;
          throw new Error(
            `Unhandled local preview result: ${JSON.stringify(exhaustive)}`
          );
        }
      }
    } catch (error) {
      next(error);
    }
  }
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
          error:
            'Builds are switched off for this project right now. Your past builds stay readable.',
          code: 'BUILDS_DISABLED',
        });
        return;
        // @feature-flag:build-from-prompt disabled-end
      }
      // @feature-flag:build-from-prompt enabled-start
      const userPerms = (req as Request & { userPermissions?: Set<string> })
        .userPermissions;
      const isProjectAdmin = Boolean(userPerms?.has('admin:roles'));
      const isSuperAdmin = isSuperAdminRequest(req);
      const body = req.body as
        | {
            feedback?: unknown;
            hasAttachments?: unknown;
            approvedLogoCandidateId?: unknown;
          }
        | undefined;
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

      if (isLogoReviewRequest(trimmedFeedback)) {
        const review = await defaultBuildLogoCandidateService.generate({
          buildId: req.params.id,
          project,
          prompt: trimmedFeedback,
          actor: {
            userId,
            isProjectAdmin,
            isSuperAdmin,
          },
        });
        res.status(202).json({ kind: 'logo_review', review });
        return;
      }

      const accepted = await defaultBuildRevisionService.requestRevision({
        buildId: req.params.id,
        project,
        feedback,
        hasAttachments: body?.hasAttachments === true,
        approvedLogoCandidateId:
          typeof body?.approvedLogoCandidateId === 'string'
            ? body.approvedLogoCandidateId
            : undefined,
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
      if (
        error instanceof BuildRevisionError ||
        error instanceof BuildLogoCandidateError
      ) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      next(error);
    }
  }
);

function buildActor(req: Request): {
  userId: string;
  isProjectAdmin: boolean;
  isSuperAdmin: boolean;
} {
  const userPerms = (req as Request & { userPermissions?: Set<string> })
    .userPermissions;
  return {
    userId: getUserId(req),
    isProjectAdmin: Boolean(userPerms?.has('admin:roles')),
    isSuperAdmin: isSuperAdminRequest(req),
  };
}

router.post(
  '/:id/logo-candidates',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:run'),
  async (req, res, next) => {
    try {
      const actor = buildActor(req);
      if (!actor.userId || actor.userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const project = resolveRequestProject(req) as string;
      const flagOn = await isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, {
        userId: actor.userId,
        project,
      });
      if (!flagOn) {
        res.status(403).json({
          error:
            'Builds are switched off for this project right now. Your past builds stay readable.',
          code: 'BUILDS_DISABLED',
        });
        return;
      }
      const prompt =
        typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      if (!prompt) {
        res
          .status(400)
          .json({
            error: 'Describe the logo you want to review.',
            code: 'FEEDBACK_REQUIRED',
          });
        return;
      }
      const review = await defaultBuildLogoCandidateService.generate({
        buildId: req.params.id,
        project,
        prompt,
        actor,
      });
      res.status(202).json(review);
    } catch (error) {
      if (error instanceof BuildLogoCandidateError) {
        res
          .status(error.statusCode)
          .json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  }
);

router.post(
  '/:id/logo-candidates/:candidateId/:decision(approve|reject)',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:run'),
  async (req, res, next) => {
    try {
      const actor = buildActor(req);
      if (!actor.userId || actor.userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const review = await defaultBuildLogoCandidateService.decide({
        buildId: req.params.id,
        project: resolveRequestProject(req) as string,
        candidateId: req.params.candidateId,
        decision: req.params.decision === 'approve' ? 'approved' : 'rejected',
        actor,
      });
      res.status(200).json(review);
    } catch (error) {
      if (error instanceof BuildLogoCandidateError) {
        res
          .status(error.statusCode)
          .json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  }
);

router.get(
  '/:id/logo-candidates/:candidateId/image',
  requireBuildsProject,
  projectAccess,
  requirePermission('builds:view'),
  async (req, res, next) => {
    try {
      const actor = buildActor(req);
      if (!actor.userId || actor.userId === 'anonymous') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const image = await defaultBuildLogoCandidateService.image({
        buildId: req.params.id,
        project: resolveRequestProject(req) as string,
        candidateId: req.params.candidateId,
        actor,
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(image);
    } catch (error) {
      if (error instanceof BuildLogoCandidateError) {
        res
          .status(error.statusCode)
          .json({ error: error.message, code: error.code });
        return;
      }
      next(error);
    }
  }
);

for (const action of ['retry-fast-edit', 'rollback-fast-edit'] as const) {
  router.post(
    `/:id/${action}`,
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
        const attemptId =
          typeof req.body?.attemptId === 'string'
            ? req.body.attemptId.trim()
            : '';
        if (!attemptId) {
          res.status(400).json({
            error: 'A revision update is required.',
            code: 'FAST_EDIT_ATTEMPT_REQUIRED',
          });
          return;
        }
        const project = resolveRequestProject(req) as string;
        const userPerms = (req as Request & { userPermissions?: Set<string> })
          .userPermissions;
        const actor = {
          userId,
          isProjectAdmin: Boolean(userPerms?.has('admin:roles')),
          isSuperAdmin: isSuperAdminRequest(req),
        };
        const result =
          action === 'retry-fast-edit'
            ? await defaultBuildRevisionService.retryFastEdit({
                buildId: req.params.id,
                project,
                attemptId,
                actor,
              })
            : await defaultBuildRevisionService.rollbackFastEdit({
                buildId: req.params.id,
                project,
                attemptId,
                actor,
              });
        res.status(202).json(result);
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
    }
  );
}

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
      const userPerms = (req as Request & { userPermissions?: Set<string> })
        .userPermissions;
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

      if (
        result.firstClaim ||
        (result.response.status === 'accepted' &&
          !result.response.pullRequestUrl)
      ) {
        void defaultBuildAcceptService.continueAccept(req.params.id);
        res.status(result.firstClaim ? 202 : 200).json(result.response);
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
  }
);

router.post(
  '/:id/confirm-intake',
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
      const row = await loadBuild(req.params.id);
      if (!row || row.project !== resolveRequestProject(req)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (!row.interviewId) {
        res.status(409).json({
          error: 'The intake conversation has not started yet.',
          code: 'INTAKE_NOT_READY',
        });
        return;
      }
      const started = await confirmAndStartPlanning(row.id, userId);
      if (!started) {
        res.status(409).json({
          error: 'Could not transition the build into planning.',
          code: 'PLANNING_START_FAILED',
        });
        return;
      }
      res.status(202).json({
        buildRunId: row.id,
        status: 'planning',
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/start-planning',
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
      const row = await loadBuild(req.params.id);
      if (!row || row.project !== resolveRequestProject(req)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const activeAgent = await getActiveBuildAgentSummary(row.id);
      if (
        !activeAgent &&
        (row.status === 'planning' || row.status === 'building')
      ) {
        void driveBuildOrchestration(row.id);
      }
      res.status(202).json({
        buildRunId: row.id,
        status: row.status,
        activeAgent,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  '/:id/design-preference-proposal',
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
      const row = await loadBuild(req.params.id);
      if (!row || row.project !== project) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (!row.skillSettingsId) {
        res.status(400).json({
          error:
            'This build has no repository configuration for design preferences.',
        });
        return;
      }
      const feedback =
        typeof (req.body as { feedback?: unknown })?.feedback === 'string'
          ? (req.body as { feedback: string }).feedback.trim()
          : '';
      if (!feedback) {
        res.status(400).json({ error: 'Feedback is required.' });
        return;
      }
      const proposal = await proposeFromBuildFeedback({
        settingsId: row.skillSettingsId,
        buildRunId: row.id,
        feedback,
        actorOid: userId,
      });
      res.status(201).json({ proposal });
    } catch (error) {
      if (error instanceof DesignPreferenceProfileError) {
        res
          .status(error.kind === 'not_found' ? 404 : 400)
          .json({ error: error.message });
        return;
      }
      next(error);
    }
  }
);

router.use(buildRunControlsRouter);
router.use(buildVerificationRouter);

export default router;
