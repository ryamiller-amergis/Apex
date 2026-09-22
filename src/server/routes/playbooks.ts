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
import { getAppEnvironment } from '../utils/superAdmin';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getRun, listRuns } from '../services/playbookRunProjectionService';
import {
  PlaybookDefinitionNotFoundError,
  PlaybookEmptyGraphError,
  PlaybookNoPublishedVersionError,
  startRun,
} from '../services/playbookRunService';
import { PlaybookGuardViolationError } from '../services/playbookGuardService';
import { advanceRun } from '../services/playbookAdvanceService';
import {
  ApprovalMissingDeadlineError,
  ApprovalNotAwaitingError,
  ApprovalNotPermittedError,
  submitApprovalDecision,
} from '../services/playbookSteps/approvalGateAdapter';

const router = express.Router();

const PLAYBOOKS_SPIKE_FLAG = 'playbooks-spike';

/** The display cap. A larger `limit` is clamped rather than refused; `total` reports the truth. */
const MAX_RUN_PAGE = 50;

/**
 * Router-level flag gate. With `playbooks-spike` off, no Playbook endpoint exists.
 *
 * 404 rather than 403 is the point: a 403 confirms the surface is there and merely withheld, and
 * the epic's success metric is that no Playbook surface appears anywhere outside local and
 * development. Mounted once here rather than repeated per handler because the feature-flags skill
 * asks for a single obvious entry point, and because a handler added later would otherwise be
 * ungated by default — the wrong way round for a flag whose whole job is keeping this dark.
 *
 * It covers the run-start and gate-decision endpoints too, which is deliberate: being able to start
 * a run you cannot see would be a strange thing for the off state to allow.
 */
const requirePlaybooksEnabled: express.RequestHandler = async (req, res, next) => {
  try {
    // Same resolution the permission guard uses, so the flag and the guard can never disagree
    // about which project a request is for.
    const project = resolveRequestProject(req);
    if (!project) {
      // A project-scoped surface addressed without a project names nothing: there is no project to
      // evaluate the flag against and none to check a permission in. 404 for the same reason as
      // below — a 400 here would confirm the route exists to a caller the flag is meant to hide it
      // from.
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const enabled = await isFeatureEnabled(PLAYBOOKS_SPIKE_FLAG, {
      userId: getUserId(req),
      project,
      environment: getAppEnvironment(),
    });

    // @feature-flag:playbooks-spike start winner=enabled
    if (!enabled) {
      // @feature-flag:playbooks-spike disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:playbooks-spike disabled-end
    }
    // @feature-flag:playbooks-spike enabled-start
    next();
    // @feature-flag:playbooks-spike enabled-end
    // @feature-flag:playbooks-spike end
  } catch (error) {
    next(error);
  }
};

router.use(requirePlaybooksEnabled);

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
    // Non-null because `requirePlaybooksEnabled` refuses a request that names no project, and it
    // runs in front of every route on this router.
    const project = resolveRequestProject(req)!;

    const requested = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit =
      Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_RUN_PAGE) : MAX_RUN_PAGE;

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

router.post(
  '/runs',
  requirePermission('playbooks:run'),
  async (req: Request, res: Response): Promise<void> => {
    const { project, definitionId } = (req.body ?? {}) as Record<string, unknown>;

    if (typeof project !== 'string' || !project.trim()) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    if (typeof definitionId !== 'string' || !definitionId.trim()) {
      res.status(400).json({ error: 'definitionId is required' });
      return;
    }

    const initiatorUserId = getUserId(req);
    if (!initiatorUserId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const result = await startRun({ project, definitionId, initiatorUserId });
      res.status(201).json(result);
    } catch (error) {
      /*
       * A missing published version is the caller's mistake, not a server fault, and PBI-001 asks
       * for the reason to be named rather than generic — someone hitting this is likely to have
       * forgotten to publish a draft, and the message should say so.
       */
      if (
        error instanceof PlaybookNoPublishedVersionError ||
        error instanceof PlaybookEmptyGraphError
      ) {
        res.status(400).json({ error: error.message });
        return;
      }

      if (error instanceof PlaybookDefinitionNotFoundError) {
        // 404 rather than 403: the permission check already passed for this project, so the caller
        // is allowed to know that no such definition exists in it.
        res.status(404).json({ error: error.message });
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
  requirePermission('playbooks:run'),
  async (req: Request, res: Response): Promise<void> => {
    const { runId, stepRunId } = req.params;
    const { decision } = (req.body ?? {}) as Record<string, unknown>;

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
      const result = await submitApprovalDecision({
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
      if (result.outcome === 'recorded') {
        await advanceRun(runId, result.stepId);
      }

      res.status(200).json(result);
    } catch (error) {
      if (error instanceof ApprovalNotPermittedError) {
        res.status(403).json({ error: error.message });
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
