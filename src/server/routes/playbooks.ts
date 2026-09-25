/**
 * The Phase 0 endpoints: start a run, decide a gate it is parked on, and read run status.
 *
 * Deliberately thin and deliberately unlovely. PBI-001 rules out any richer UI, and records
 * accessibility as not applicable, precisely because this is a developer-facing endpoint that the
 * seed script and the tests call. Anything more would be building the Phase 1 surface early and
 * having to unpick it.
 *
 * `requirePermission` resolves the project from `req.body.project`, so the guard is scoped to the
 * project the caller names rather than to the platform.
 */
import express, { Request, Response } from 'express';
import { requirePermission, resolveRequestProject } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import { getRun, listRuns } from '../services/playbookRunProjectionService';
import {
  PlaybookDefinitionNotFoundError,
  PlaybookEmptyGraphError,
  PlaybookNoPublishedVersionError,
  PlaybookVersionPinNotFoundError,
  PlaybookVersionPinNotPublishedError,
  PlaybookVersionPinReasonRequiredError,
  startRun,
} from '../services/playbookRunService';
import { PlaybookGuardViolationError } from '../services/playbookGuardService';
import {
  PlaybookDefinitionNotFoundError as PlaybookLifecycleDefinitionNotFoundError,
  PlaybookDraftConflictError,
  PlaybookDraftNotFoundError,
  PlaybookVersionImmutableError,
  PlaybookVersionNotFoundError,
  PlaybookVersionTransitionError,
  createDefinition,
  deprecateVersion,
  getDefinitionDetail,
  listDefinitions,
  publishDraft,
  updateDraft,
} from '../services/playbookDefinitionService';
import { PlaybookStepSchemaError } from '../services/playbookSteps/descriptorValidation';
import {
  PlaybookStepTypeError,
  UnknownPlaybookStepTypeError,
  isProductionAdapterStep,
} from '../services/playbookSteps/registry';
import { advanceRun } from '../services/playbookAdvanceService';
import {
  ApprovalMissingDeadlineError,
  ApprovalNotAwaitingError,
  ApprovalNotPermittedError,
  submitApprovalDecision,
} from '../services/playbookSteps/approvalGateAdapter';
import {
  PlaybookSpendCapExceededError,
  PlaybookSpendConfigurationError,
  PlaybookSpendPolicyValidationError,
  playbookSpendPolicyService,
} from '../services/playbookSpendPolicyService';
import {
  PlaybookRunActionConflictError,
  PlaybookRunActionForbiddenError,
  PlaybookRunActionNotFoundError,
  cancelPlaybookRun,
  retryPlaybookStep,
} from '../services/playbookRunActionService';
import { isFeatureEnabled } from '../services/featureFlagService';
import {
  PlaybookGateEmptyPoolError,
  PlaybookGateForbiddenError,
  PlaybookGateInputRenderError,
  PlaybookGateNotFoundError,
  decideGate,
  getGateDetail,
  isProductionGateStepRun,
} from '../services/playbookGateService';
import { getUserPermissions } from '../services/rbacService';

const router = express.Router();

/** The display cap. A larger `limit` is clamped rather than refused; `total` reports the truth. */
const MAX_RUN_PAGE = 50;
const PRODUCTION_ADAPTERS_FLAG = 'playbooks-production-adapters';

type RequestBody = Record<string, unknown>;

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlaybookGraph(value: unknown): value is {
  nodes: Array<{ id: string; stepType: string; config?: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; condition?: string }>;
} {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Record<string, unknown>;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return false;

  const nodesAreValid = graph.nodes.every((node) => {
    if (!node || typeof node !== 'object') return false;
    const candidate = node as Record<string, unknown>;
    if (!isNonBlankString(candidate.id) || !isNonBlankString(candidate.stepType)) return false;
    return (
      candidate.config === undefined ||
      (candidate.config !== null &&
        typeof candidate.config === 'object' &&
        !Array.isArray(candidate.config))
    );
  });
  const edgesAreValid = graph.edges.every((edge) => {
    if (!edge || typeof edge !== 'object') return false;
    const candidate = edge as Record<string, unknown>;
    return (
      isNonBlankString(candidate.from) &&
      isNonBlankString(candidate.to) &&
      (candidate.condition === undefined || typeof candidate.condition === 'string')
    );
  });

  return nodesAreValid && edgesAreValid;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function sendDefinitionError(error: unknown, res: Response): boolean {
  if (error instanceof PlaybookGuardViolationError) {
    res.status(400).json({ error: error.message, violation: error.violation });
    return true;
  }

  if (
    error instanceof UnknownPlaybookStepTypeError ||
    error instanceof PlaybookStepSchemaError ||
    error instanceof PlaybookStepTypeError
  ) {
    res.status(400).json({ error: error.message });
    return true;
  }

  if (
    error instanceof PlaybookLifecycleDefinitionNotFoundError ||
    error instanceof PlaybookDraftNotFoundError ||
    error instanceof PlaybookVersionNotFoundError
  ) {
    res.status(404).json({ error: error.message });
    return true;
  }

  if (
    error instanceof PlaybookDraftConflictError ||
    error instanceof PlaybookVersionImmutableError ||
    error instanceof PlaybookVersionTransitionError ||
    isUniqueViolation(error)
  ) {
    res.status(409).json({
      error: error instanceof Error ? error.message : 'A conflicting Playbook definition exists.',
    });
    return true;
  }

  return false;
}

/** Reject project-scoped requests that do not name a project. */
const requirePlaybooksProject: express.RequestHandler = async (req, res, next) => {
  try {
    const project = resolveRequestProject(req);
    if (!project) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
};

router.use(requirePlaybooksProject);

async function productionAdaptersFlagEnabled(req: Request, project: string): Promise<boolean> {
  return isFeatureEnabled(PRODUCTION_ADAPTERS_FLAG, {
    userId: getUserId(req),
    project,
  });
}

router.get(
  '/spend-policy',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;
    const enabled = await productionAdaptersFlagEnabled(req, project);

    // @feature-flag:playbooks-production-adapters start winner=enabled
    if (!enabled) {
      // @feature-flag:playbooks-production-adapters disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:playbooks-production-adapters disabled-end
    }
    // @feature-flag:playbooks-production-adapters enabled-start
    res.json(await playbookSpendPolicyService.getPolicy(project));
    // @feature-flag:playbooks-production-adapters enabled-end
    // @feature-flag:playbooks-production-adapters end
  },
);

router.patch(
  '/spend-policy',
  requirePermission('playbooks:admin'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;
    const enabled = await productionAdaptersFlagEnabled(req, project);

    // @feature-flag:playbooks-production-adapters start winner=enabled
    if (!enabled) {
      // @feature-flag:playbooks-production-adapters disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:playbooks-production-adapters disabled-end
    }
    // @feature-flag:playbooks-production-adapters enabled-start
    const { reason, capUsd, enabled: policyEnabled } = (req.body ?? {}) as RequestBody;
    if (!isNonBlankString(reason)) {
      res.status(400).json({ error: 'reason is required' });
      return;
    }
    if (capUsd !== undefined && typeof capUsd !== 'string') {
      res.status(400).json({ error: 'capUsd must be a decimal string' });
      return;
    }
    if (policyEnabled !== undefined && typeof policyEnabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const actorUserId = getUserId(req);
    if (!actorUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      res.json(await playbookSpendPolicyService.updatePolicy({
        project,
        actorUserId,
        reason,
        ...(capUsd !== undefined ? { capUsd } : {}),
        ...(policyEnabled !== undefined ? { enabled: policyEnabled } : {}),
      }));
    } catch (error) {
      if (
        error instanceof PlaybookSpendPolicyValidationError ||
        error instanceof PlaybookSpendConfigurationError
      ) {
        res.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    // @feature-flag:playbooks-production-adapters enabled-end
    // @feature-flag:playbooks-production-adapters end
  },
);

router.get(
  '/definitions',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;
    res.json(await listDefinitions(project));
  }
);

router.post(
  '/definitions',
  requirePermission('playbooks:author'),
  async (req: Request, res: Response): Promise<void> => {
    const { project, name, description, graph } = (req.body ?? {}) as RequestBody;
    if (!isNonBlankString(project)) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (!isNonBlankString(name)) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (description !== undefined && typeof description !== 'string') {
      res.status(400).json({ error: 'description must be a string' });
      return;
    }
    if (!isPlaybookGraph(graph)) {
      res.status(400).json({ error: 'graph must contain valid nodes and edges arrays' });
      return;
    }

    const createdByUserId = getUserId(req);
    if (!createdByUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const result = await createDefinition({
        project,
        name,
        description,
        graph,
        createdByUserId,
      });
      res.status(201).json(result);
    } catch (error) {
      if (!sendDefinitionError(error, res)) throw error;
    }
  }
);

router.get(
  '/definitions/:definitionId',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;
    try {
      res.json(await getDefinitionDetail(project, req.params.definitionId));
    } catch (error) {
      if (!sendDefinitionError(error, res)) throw error;
    }
  }
);

router.put(
  '/definitions/:definitionId/draft',
  requirePermission('playbooks:author'),
  async (req: Request, res: Response): Promise<void> => {
    const { project, name, description, graph, expectedDraftUpdatedAt } = (req.body ??
      {}) as RequestBody;
    if (!isNonBlankString(project)) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (!isNonBlankString(name)) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (description !== undefined && typeof description !== 'string') {
      res.status(400).json({ error: 'description must be a string' });
      return;
    }
    if (!isPlaybookGraph(graph)) {
      res.status(400).json({ error: 'graph must contain valid nodes and edges arrays' });
      return;
    }
    if (!isNonBlankString(expectedDraftUpdatedAt)) {
      res.status(400).json({ error: 'expectedDraftUpdatedAt is required' });
      return;
    }

    try {
      res.json(
        await updateDraft({
          project,
          definitionId: req.params.definitionId,
          name,
          description,
          graph,
          expectedDraftUpdatedAt,
        })
      );
    } catch (error) {
      if (!sendDefinitionError(error, res)) throw error;
    }
  }
);

router.post(
  '/definitions/:definitionId/publish',
  requirePermission('playbooks:author'),
  async (req: Request, res: Response): Promise<void> => {
    const { project, expectedDraftUpdatedAt } = (req.body ?? {}) as RequestBody;
    if (!isNonBlankString(project)) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (!isNonBlankString(expectedDraftUpdatedAt)) {
      res.status(400).json({ error: 'expectedDraftUpdatedAt is required' });
      return;
    }

    const publishedByUserId = getUserId(req);
    if (!publishedByUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const productionAdaptersEnabled = await productionAdaptersFlagEnabled(req, project);
      if (!productionAdaptersEnabled) {
        const detail = await getDefinitionDetail(project, req.params.definitionId);
        const usesProductionAdapters = detail.draft.graph.nodes.some(
          (node) => isProductionAdapterStep(node.stepType, node.config),
        );
        if (usesProductionAdapters) {
          res.status(409).json({
            error: 'Production Playbook adapters are disabled.',
            code: 'PLAYBOOK_PRODUCTION_ADAPTERS_DISABLED',
          });
          return;
        }
      }
      const result = await publishDraft({
        project,
        definitionId: req.params.definitionId,
        publishedByUserId,
        expectedDraftUpdatedAt,
      });
      res.status(201).json(result);
    } catch (error) {
      if (!sendDefinitionError(error, res)) throw error;
    }
  }
);

router.post(
  '/definitions/:definitionId/versions/:versionId/deprecate',
  requirePermission('playbooks:author'),
  async (req: Request, res: Response): Promise<void> => {
    const { project } = (req.body ?? {}) as RequestBody;
    if (!isNonBlankString(project)) {
      res.status(400).json({ error: 'project is required' });
      return;
    }

    try {
      res.json(
        await deprecateVersion({
          project,
          definitionId: req.params.definitionId,
          versionId: req.params.versionId,
        })
      );
    } catch (error) {
      if (!sendDefinitionError(error, res)) throw error;
    }
  }
);

/**
 * `GET /api/playbooks/runs?project=&limit=` — runs in a project, most recent first.
 *
 * A pass-through, and deliberately dull. TBI-025 (a) requires every field on screen to trace to the
 * projection, and the way that rule breaks is not a decision to break it — it is one convenience
 * added to a route, then another. So this resolves the project, clamps the limit, calls the
 * projection and returns what it got. There is no error path that reads an engine table, because
 * there is no error path that reads anything.
 */
router.get(
  '/runs',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    // Non-null because `requirePlaybooksProject` refuses a request that names no project, and it
    // runs in front of every route on this router.
    const project = resolveRequestProject(req)!;

    const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit =
      Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_RUN_PAGE) : MAX_RUN_PAGE;

    const filter = req.query.filter;
    if (filter !== undefined && filter !== 'assigned-to-me') {
      res.status(400).json({ error: 'Unknown Playbook run filter.' });
      return;
    }
    if (filter === 'assigned-to-me') {
      if (!(await productionAdaptersFlagEnabled(req, project))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const userId = getUserId(req);
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      res.json(await listRuns(project, limit, userId));
      return;
    }
    res.json(await listRuns(project, limit));
  }
);

/**
 * `GET /api/playbooks/runs/:runId?project=` — one run, its ordered steps and what it waits on.
 *
 * The projection scopes by project in its own query, so a run belonging to another project is
 * indistinguishable from one that does not exist. That is the intended answer rather than a lossy
 * one: telling a caller a run exists but is not theirs is more than the guard established.
 */
router.get(
  '/runs/:runId',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;

    const run = await getRun(project, req.params.runId);
    if (!run) {
      res.status(404).json({ error: 'No such Playbook run in this project.' });
      return;
    }

    res.json(run);
  }
);

router.get(
  '/runs/:runId/steps/:stepRunId/gate',
  requirePermission('playbooks:view'),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req)!;
    if (!(await productionAdaptersFlagEnabled(req, project))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      res.json(await getGateDetail({
        project,
        runId: req.params.runId,
        stepRunId: req.params.stepRunId,
        userId,
      }));
    } catch (error) {
      if (error instanceof PlaybookGateForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof PlaybookGateNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (
        error instanceof PlaybookGateInputRenderError
        || error instanceof PlaybookGateEmptyPoolError
      ) {
        res.status(409).json({ error: error.message, code: error.name });
        return;
      }
      throw error;
    }
  },
);

router.post(
  '/runs',
  requirePermission('playbooks:run'),
  async (req: Request, res: Response): Promise<void> => {
    const { project, definitionId, definitionVersionId, versionPinReason } = (req.body ??
      {}) as RequestBody;

    if (typeof project !== 'string' || !project.trim()) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (typeof definitionId !== 'string' || !definitionId.trim()) {
      res.status(400).json({ error: 'definitionId is required' });
      return;
    }
    const hasVersionId = definitionVersionId !== undefined;
    const hasPinReason = versionPinReason !== undefined;
    if (hasVersionId !== hasPinReason) {
      res.status(400).json({
        error: 'definitionVersionId and versionPinReason must be provided together',
      });
      return;
    }
    if (hasVersionId && !isNonBlankString(definitionVersionId)) {
      res.status(400).json({ error: 'definitionVersionId must be a non-blank string' });
      return;
    }
    if (hasPinReason && !isNonBlankString(versionPinReason)) {
      res.status(400).json({ error: 'versionPinReason must be a non-blank string' });
      return;
    }

    const initiatorUserId = getUserId(req);
    if (!initiatorUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const spendAdmissionEnabled = await productionAdaptersFlagEnabled(req, project);
      const result = await startRun({
        project,
        definitionId,
        ...(definitionVersionId !== undefined
          ? { definitionVersionId, versionPinReason: versionPinReason as string }
          : {}),
        initiatorUserId,
        ...(spendAdmissionEnabled ? { spendAdmissionEnabled: true } : {}),
      });
      res.status(201).json(result);
    } catch (error) {
      /*
       * A missing published version is the caller's mistake, not a server fault, and PBI-001 asks
       * for the reason to be named rather than generic — someone hitting this is likely to have
       * forgotten to publish a draft, and the message should say so.
       */
      if (
        error instanceof PlaybookNoPublishedVersionError ||
        error instanceof PlaybookEmptyGraphError ||
        error instanceof PlaybookVersionPinReasonRequiredError
      ) {
        res.status(400).json({ error: error.message });
        return;
      }

      if (
        error instanceof PlaybookDefinitionNotFoundError ||
        error instanceof PlaybookVersionPinNotFoundError
      ) {
        // 404 rather than 403: the permission check already passed for this project, so the caller
        // is allowed to know that no such definition exists in it.
        res.status(404).json({ error: error.message });
        return;
      }

      if (error instanceof PlaybookVersionPinNotPublishedError) {
        res.status(409).json({ error: error.message });
        return;
      }

      if (error instanceof PlaybookSpendCapExceededError) {
        res.status(409).json({
          error: error.message,
          code: error.code,
          currentSpendUsd: error.currentSpendUsd,
          capUsd: error.capUsd,
          requiredPermission: error.requiredPermission,
        });
        return;
      }

      if (error instanceof PlaybookGuardViolationError) {
        // Refused by a structural guard. 400 because the graph or the project's concurrency is the
        // problem, and `kind` lets a caller tell "too many steps" from "too many runs".
        res.status(400).json({ error: error.message, violation: error.violation });
        return;
      }

      throw error;
    }
  }
);

function sendRunActionError(error: unknown, res: Response): boolean {
  if (error instanceof PlaybookRunActionForbiddenError) {
    res.status(403).json({ error: error.message });
    return true;
  }
  if (error instanceof PlaybookRunActionNotFoundError) {
    res.status(404).json({ error: error.message });
    return true;
  }
  if (error instanceof PlaybookRunActionConflictError) {
    res.status(409).json({ error: error.message });
    return true;
  }
  return false;
}

router.post(
  '/runs/:runId/cancel',
  async (req: Request, res: Response): Promise<void> => {
    const { project, reason } = (req.body ?? {}) as RequestBody;
    if (!req.user || !getUserId(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!isNonBlankString(project)) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (reason !== undefined && typeof reason !== 'string') {
      res.status(400).json({ error: 'reason must be a string' });
      return;
    }

    try {
      res.json(
        await cancelPlaybookRun({
          runId: req.params.runId,
          project,
          actorUserId: getUserId(req)!,
          isSuperAdmin: isSuperAdminRequest(req),
          ...(reason?.trim() ? { reason: reason.trim() } : {}),
        })
      );
    } catch (error) {
      if (!sendRunActionError(error, res)) throw error;
    }
  }
);

router.post(
  '/runs/:runId/steps/:stepRunId/retry',
  async (req: Request, res: Response): Promise<void> => {
    const { project } = (req.body ?? {}) as RequestBody;
    if (!req.user || !getUserId(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!isNonBlankString(project)) {
      res.status(400).json({ error: 'project is required' });
      return;
    }

    try {
      res.json(
        await retryPlaybookStep({
          runId: req.params.runId,
          stepRunId: req.params.stepRunId,
          project,
          actorUserId: getUserId(req)!,
          isSuperAdmin: isSuperAdminRequest(req),
        })
      );
    } catch (error) {
      if (!sendRunActionError(error, res)) throw error;
    }
  }
);

/**
 * `POST /api/playbooks/runs/:runId/steps/:stepRunId/decision` — approve or reject a parked gate.
 *
 * Nested under the run because that is what the caller has: the status view lists runs, and a
 * parked one names the step waiting. It also means the run id is available to check the step
 * belongs to it, rather than trusting a step id from a path that says nothing about its parent.
 *
 * Gated on `playbooks:run` rather than a distinct approval permission. Phase 0 restricts deciding
 * to the run's initiator, enforced in the adapter, so a separate permission would have nobody
 * different to grant it to.
 */
router.post(
  '/runs/:runId/steps/:stepRunId/decision',
  async (req: Request, res: Response): Promise<void> => {
    const { runId, stepRunId } = req.params;
    const { decision, comment } = (req.body ?? {}) as Record<string, unknown>;

    if (decision !== 'approved' && decision !== 'rejected') {
      res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
      return;
    }

    const deciderUserId = getUserId(req);
    if (!deciderUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const project = resolveRequestProject(req)!;
      const productionAdaptersEnabled = await productionAdaptersFlagEnabled(req, project);
      const useProductionGate = productionAdaptersEnabled
        && await isProductionGateStepRun(stepRunId);
      if (!useProductionGate) {
        const permissions = await getUserPermissions(deciderUserId, project);
        if (!permissions.has('playbooks:run')) {
          res.status(403).json({ error: 'Missing required permission: playbooks:run' });
          return;
        }
      }
      const result = useProductionGate
        ? await decideGate({
            project,
            stepRunId,
            runId,
            userId: deciderUserId,
            decision,
            ...(typeof comment === 'string' ? { comment } : {}),
          })
        : await submitApprovalDecision({
            stepRunId,
            runId,
            deciderUserId,
            decision,
          });

      /*
       * PBI-004 asks for the next step to be under way before the response returns, so this is
       * awaited rather than left to the sweep — a person who approves a gate and immediately
       * refreshes should see the run moving, not still sitting where they left it.
       *
       * Only on `recorded`. An `already-decided` outcome moved nothing, so whatever did move the
       * step has already advanced the run.
       *
       * `advanceRun` does not throw, which is what makes awaiting it safe here: the decision is
       * already durably recorded, and failing this response would tell the caller their approval
       * did not happen when it did.
       */
      if (result.outcome === 'recorded' && 'stepId' in result && result.stepId) {
        await advanceRun(runId, result.stepId);
      }

      res.status(200).json(result);
    } catch (error) {
      if (error instanceof ApprovalNotPermittedError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof PlaybookGateForbiddenError) {
        res.status(403).json({ error: error.message });
        return;
      }
      if (error instanceof PlaybookGateNotFoundError) {
        res.status(404).json({ error: error.message });
        return;
      }
      if (error instanceof PlaybookGateEmptyPoolError) {
        res.status(409).json({ error: error.message, code: error.name });
        return;
      }

      /*
       * 409 for both: the request is well formed and the caller is allowed to make it, but the
       * step is not in a state where it means anything. Retrying the identical request after the
       * step moves is exactly what a caller should do, which is what separates this from a 400.
       */
      if (
        error instanceof ApprovalNotAwaitingError ||
        error instanceof ApprovalMissingDeadlineError
      ) {
        res.status(409).json({ error: error.message });
        return;
      }

      throw error;
    }
  }
);

export default router;
