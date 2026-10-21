/**
 * Reviewer API for workflow evaluations.
 * Mounted at /api/projects/:projectId/workflow-evaluations.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import { requireWorkflowEvaluationFlag } from '../middleware/workflowEvaluationAccess';
import { getUserId } from '../utils/requestUser';
import {
  WORKFLOW_EVALUATION_SUBMIT,
  WORKFLOW_EVALUATION_VIEW,
} from '../../shared/types/workflowEvaluationAccess';
import {
  CREATE_WORKFLOW_EVALUATION_REQUEST_FIELDS,
  WORKFLOW_EVALUATION_JOB_EVALUATORS,
  type CreateWorkflowEvaluationRequest,
  type WorkflowEvaluationJobEvaluator,
  type WorkflowEvaluationSubjectType,
} from '../../shared/types/workflowEvaluation';
import { WorkflowEvaluationError } from '../services/workflowEvaluationError';
import {
  createWorkflowEvaluationJobOrchestrator,
  registerWorkflowEvaluationJobListener,
  type WorkflowEvaluationJobFailureCode,
} from '../services/workflowEvaluationJobOrchestrator';
import * as workflowEvaluationService from '../services/workflowEvaluationService';

const router = Router({ mergeParams: true });

const jobOrchestrator = createWorkflowEvaluationJobOrchestrator();
registerWorkflowEvaluationJobListener(jobOrchestrator);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathProject(req: Request): string {
  const projectId = req.params.projectId;
  return typeof projectId === 'string' ? projectId : '';
}

/** Query, body, or x-apex-project must not name a project other than the path. */
function projectMismatch(req: Request): boolean {
  const path = pathProject(req);
  const named = [
    req.query?.project,
    (req.body as { project?: unknown } | undefined)?.project,
    req.get?.('x-apex-project') ?? req.headers?.['x-apex-project'],
  ];
  return named.some((value) => typeof value === 'string' && value.length > 0 && value !== path);
}

const rejectProjectMismatch: (req: Request, res: Response, next: NextFunction) => void = (req, res, next) => {
  if (projectMismatch(req)) {
    res.status(400).json({ error: 'project does not match the request project' });
    return;
  }
  next();
};

const requireNamedUser: (req: Request, res: Response, next: NextFunction) => void = (req, res, next) => {
  if (getUserId(req) === 'anonymous') {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
};

router.use(rejectProjectMismatch);
router.use(requireProjectAccess(resolveRequestProject));
router.use(requireNamedUser);

function handleServiceError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof WorkflowEvaluationError) {
    const status = err.code === 'SUBJECT_NOT_FOUND'
      ? 404
      : err.code === 'ARTIFACT_STORAGE_UNAVAILABLE'
        ? 503
        : 422;
    res.status(status).json({
      error: err.message,
      code: err.code,
      ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}),
    });
    return;
  }
  next(err);
}

function isSubjectType(value: unknown): value is WorkflowEvaluationSubjectType {
  return value === 'prd' || value === 'interview_phase';
}

router.get(
  '/definitions',
  requirePermission(WORKFLOW_EVALUATION_VIEW),
  requireWorkflowEvaluationFlag,
  async (req, res, next) => {
    try {
      const subjectType = req.query.subjectType;
      const stageKey = typeof req.query.stageKey === 'string' ? req.query.stageKey : undefined;
      if (subjectType !== undefined && !isSubjectType(subjectType)) {
        res.status(422).json({ error: 'subjectType is invalid', code: 'UNKNOWN_FIELD' });
        return;
      }
      const body = await workflowEvaluationService.listEvaluationDefinitions(
        pathProject(req),
        getUserId(req),
        { subjectType, stageKey },
      );
      res.json(body);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  },
);

router.get(
  '/events',
  requirePermission(WORKFLOW_EVALUATION_VIEW),
  requireWorkflowEvaluationFlag,
  async (req, res, next) => {
    try {
      const subjectType = req.query.subjectType;
      const subjectId = req.query.subjectId;
      if (!isSubjectType(subjectType) || typeof subjectId !== 'string' || !subjectId) {
        res.status(422).json({
          error: 'subjectType and subjectId are required',
          code: 'UNKNOWN_FIELD',
        });
        return;
      }
      const stageKey = typeof req.query.stageKey === 'string' ? req.query.stageKey : undefined;
      const includeOlderVersions = req.query.includeOlder === 'true';
      const body = await workflowEvaluationService.listEvaluationEvents(pathProject(req), {
        subjectType,
        subjectId,
        stageKey,
        includeOlderVersions,
      });
      res.json(body);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  },
);

router.post(
  '/events',
  requirePermission(WORKFLOW_EVALUATION_SUBMIT),
  requireWorkflowEvaluationFlag,
  async (req, res, next) => {
    try {
      const parsed = parseCreateBody(req.body);
      const event = await workflowEvaluationService.submitEvaluation(
        pathProject(req),
        getUserId(req),
        parsed,
      );
      res.status(201).json(event);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  },
);

router.get(
  '/events/:eventId',
  requirePermission(WORKFLOW_EVALUATION_VIEW),
  requireWorkflowEvaluationFlag,
  async (req, res, next) => {
    try {
      const eventId = req.params.eventId;
      if (typeof eventId !== 'string' || !UUID_RE.test(eventId)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const event = await workflowEvaluationService.getEvaluationEvent(pathProject(req), eventId);
      if (!event) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(event);
    } catch (err) {
      handleServiceError(err, res, next);
    }
  },
);

function retryFailureStatus(code: WorkflowEvaluationJobFailureCode): number {
  switch (code) {
    case 'enqueue_failed':
    case 'enqueue_interrupted':
      return 502;
    case 'artifact_unavailable':
    case 'artifact_changed':
    case 'suite_missing':
    case 'skill_config_missing':
    case 'specification_invalid':
    case 'flag_disabled':
    case 'transport_disabled':
      return 409;
    default: {
      const unhandled: never = code;
      throw new Error(`Unhandled job failure code: ${String(unhandled)}`);
    }
  }
}

router.post(
  '/events/:eventId/jobs/:evaluatorKey/retry',
  requirePermission('admin:roles'),
  requireWorkflowEvaluationFlag,
  async (req, res, next) => {
    try {
      const { eventId, evaluatorKey } = req.params;
      if (
        typeof eventId !== 'string'
        || !UUID_RE.test(eventId)
        || !(WORKFLOW_EVALUATION_JOB_EVALUATORS as readonly string[]).includes(evaluatorKey)
      ) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const result = await jobOrchestrator.retryJob({
        projectId: pathProject(req),
        eventId,
        evaluatorKey: evaluatorKey as WorkflowEvaluationJobEvaluator,
        userId: getUserId(req),
      });
      switch (result.status) {
        case 'dispatched':
          res.json({ job: result.job });
          return;
        case 'not_found':
          res.status(404).json({ error: 'Not found' });
          return;
        case 'job_not_failed':
          res.status(409).json({
            error: 'Only a failed job can be retried.',
            code: 'job_not_failed',
            job: result.job,
          });
          return;
        case 'failed':
          res.status(retryFailureStatus(result.code)).json({
            error: result.message,
            code: result.code,
            job: result.job,
          });
          return;
        default: {
          const unhandled: never = result;
          throw new Error(`Unhandled retry result: ${JSON.stringify(unhandled)}`);
        }
      }
    } catch (err) {
      next(err);
    }
  },
);

function parseCreateBody(body: unknown): CreateWorkflowEvaluationRequest {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new WorkflowEvaluationError('UNKNOWN_FIELD', 'Request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set<string>(CREATE_WORKFLOW_EVALUATION_REQUEST_FIELDS);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const key of unknown) fieldErrors[key] = 'Unknown field';
    throw new WorkflowEvaluationError(
      'UNKNOWN_FIELD',
      `Unknown field: ${unknown.join(', ')}`,
      fieldErrors,
    );
  }
  return record as unknown as CreateWorkflowEvaluationRequest;
}

export default router;
