import type { Request, Response, NextFunction, RequestHandler } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  requireSuperAdmin,
  resolveRequestProject,
} from './rbac';
import { isFeatureEnabled, isFeatureOperational } from '../services/featureFlagService';
import { getUserId } from '../utils/requestUser';
import { WORKFLOW_HUMAN_EVALUATION_FLAG } from '../../shared/types/featureFlags';
import {
  WORKFLOW_EVALUATION_SUBMIT,
  WORKFLOW_EVALUATION_VIEW,
} from '../../shared/types/workflowEvaluationAccess';

export { WORKFLOW_EVALUATION_SUBMIT, WORKFLOW_EVALUATION_VIEW };

export const BODY_PROJECT_ERROR = 'project must not be sent in the request body';
export const MISSING_PROJECT_ERROR = 'project query or x-apex-project header is required';

/**
 * Cleanup plan for `workflow-human-evaluation`: retain the enabled branch
 * after two stable sprints at full rollout.
 */
export const rejectBodyProject: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const body = req.body as unknown;
  if (
    body !== null
    && typeof body === 'object'
    && !Array.isArray(body)
    && Object.prototype.hasOwnProperty.call(body, 'project')
  ) {
    res.status(400).json({ error: BODY_PROJECT_ERROR });
    return;
  }
  next();
};

export const requireWorkflowEvaluationFlag: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const project = resolveRequestProject(req);
    if (!project) {
      res.status(400).json({ error: MISSING_PROJECT_ERROR });
      return;
    }
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled(WORKFLOW_HUMAN_EVALUATION_FLAG, { userId, project });
    // @feature-flag:workflow-human-evaluation start winner=enabled
    if (!enabled) {
      // @feature-flag:workflow-human-evaluation disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:workflow-human-evaluation disabled-end
    }
    // @feature-flag:workflow-human-evaluation enabled-start
    next();
    // @feature-flag:workflow-human-evaluation enabled-end
    // @feature-flag:workflow-human-evaluation end
  } catch (err) {
    next(err);
  }
};

export const requireWorkflowEvaluationOperational: RequestHandler = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const operational = await isFeatureOperational(WORKFLOW_HUMAN_EVALUATION_FLAG);
    // @feature-flag:workflow-human-evaluation start winner=enabled
    if (!operational) {
      // @feature-flag:workflow-human-evaluation disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:workflow-human-evaluation disabled-end
    }
    // @feature-flag:workflow-human-evaluation enabled-start
    next();
    // @feature-flag:workflow-human-evaluation enabled-end
    // @feature-flag:workflow-human-evaluation end
  } catch (err) {
    next(err);
  }
};

export const workflowEvaluationReadGuard: RequestHandler[] = [
  rejectBodyProject,
  requirePermission(WORKFLOW_EVALUATION_VIEW),
  requireProjectAccess(resolveRequestProject),
  requireWorkflowEvaluationFlag,
];

export const workflowEvaluationSubmitGuard: RequestHandler[] = [
  rejectBodyProject,
  requirePermission(WORKFLOW_EVALUATION_VIEW, WORKFLOW_EVALUATION_SUBMIT),
  requireProjectAccess(resolveRequestProject),
  requireWorkflowEvaluationFlag,
];

export const workflowEvaluationAdminGuard: RequestHandler[] = [
  rejectBodyProject,
  requirePermission('admin:roles'),
  requireProjectAccess(resolveRequestProject),
  requireWorkflowEvaluationFlag,
];

export const workflowEvaluationHubGuard: RequestHandler[] = [
  requireSuperAdmin,
  requireWorkflowEvaluationOperational,
];
