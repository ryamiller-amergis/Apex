/**
 * `POST /api/playbooks/runs` — the Phase 0 trigger.
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

      throw error;
    }
  }
);

export default router;
