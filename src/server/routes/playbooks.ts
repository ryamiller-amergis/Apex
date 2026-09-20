/**
 * The two Phase 0 endpoints: start a run, and decide a gate it is parked on.
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
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  PlaybookDefinitionNotFoundError,
  PlaybookEmptyGraphError,
  PlaybookNoPublishedVersionError,
  startRun,
} from '../services/playbookRunService';
import { PlaybookGuardViolationError } from '../services/playbookGuardService';
import {
  ApprovalMissingDeadlineError,
  ApprovalNotAwaitingError,
  ApprovalNotPermittedError,
  submitApprovalDecision,
} from '../services/playbookSteps/approvalGateAdapter';

const router = express.Router();

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
