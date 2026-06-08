import { Router } from 'express';
import * as outcomeService from '../services/deploymentOutcomeService';
import { getUserId } from '../utils/requestUser';
import type { CreateOutcomeInput, DeploymentResult, UpdateOutcomeInput } from '../../shared/types/deploymentOutcome';

const router = Router();

// POST / — record a new deployment outcome
router.post('/', async (req, res) => {
  try {
    const userId = getUserId(req);
    const body = req.body as CreateOutcomeInput;

    if (!body.deploymentId || !body.releaseVersion || !body.result) {
      return res.status(400).json({ error: 'deploymentId, releaseVersion, and result are required' });
    }

    const validResults: DeploymentResult[] = ['success', 'downtime', 'rollback'];
    if (!validResults.includes(body.result)) {
      return res.status(400).json({ error: `result must be one of: ${validResults.join(', ')}` });
    }

    const outcome = await outcomeService.recordOutcome(body, userId);
    res.status(201).json(outcome);
  } catch (err) {
    console.error('[deployment-outcomes] POST / error:', err);
    res.status(500).json({ error: 'Failed to record deployment outcome' });
  }
});

// GET /versions — all distinct release versions that have outcomes
router.get('/versions', async (req, res) => {
  try {
    const versions = await outcomeService.getDistinctReleaseVersions();
    res.json(versions);
  } catch (err) {
    console.error('[deployment-outcomes] GET /versions error:', err);
    res.status(500).json({ error: 'Failed to fetch release versions' });
  }
});

// GET /list — filtered list of outcomes for the report data table
router.get('/list', async (req, res) => {
  try {
    const { startDate, endDate, result } = req.query as {
      startDate?: string;
      endDate?: string;
      result?: DeploymentResult;
    };
    const rv = req.query['releaseVersions'];
    const releaseVersions = Array.isArray(rv) ? (rv as string[]) : rv ? [rv as string] : undefined;

    const outcomes = await outcomeService.getAllOutcomes({
      startDate,
      endDate,
      result,
      releaseVersions,
    });
    res.json(outcomes);
  } catch (err) {
    console.error('[deployment-outcomes] GET /list error:', err);
    res.status(500).json({ error: 'Failed to list outcomes' });
  }
});

// GET /report — aggregated summary (must be before /:deploymentId to avoid conflict)
router.get('/report', async (req, res) => {
  try {
    const { startDate, endDate, result } = req.query as {
      startDate?: string;
      endDate?: string;
      result?: DeploymentResult;
    };
    const rv = req.query['releaseVersions'];
    const releaseVersions = Array.isArray(rv) ? (rv as string[]) : rv ? [rv as string] : undefined;

    const summary = await outcomeService.getOutcomeSummary({
      startDate,
      endDate,
      result,
      releaseVersions,
    });
    res.json(summary);
  } catch (err) {
    console.error('[deployment-outcomes] GET /report error:', err);
    res.status(500).json({ error: 'Failed to generate outcome report' });
  }
});

// GET /export — CSV or JSON data for client-side PDF
router.get('/export', async (req, res) => {
  try {
    const { format, startDate, endDate, result } = req.query as {
      format?: 'csv' | 'pdf';
      startDate?: string;
      endDate?: string;
      result?: DeploymentResult;
    };
    const rv = req.query['releaseVersions'];
    const releaseVersions = Array.isArray(rv) ? (rv as string[]) : rv ? [rv as string] : undefined;

    const outcomes = await outcomeService.getAllOutcomes({
      startDate,
      endDate,
      result,
      releaseVersions,
    });

    if (format === 'csv') {
      const csvHeader = 'ID,Release Version,Result,Downtime Minutes,Details,Reported By,Reported At';
      const csvRows = outcomes.map((o) =>
        [
          o.id,
          escapeCsv(o.releaseVersion),
          o.result,
          o.downtimeMinutes ?? '',
          escapeCsv(o.details ?? ''),
          escapeCsv(o.reportedBy),
          o.reportedAt,
        ].join(','),
      );
      const csv = [csvHeader, ...csvRows].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="deployment-outcomes.csv"');
      return res.send(csv);
    }

    // Default: return JSON data (used by client-side PDF generation)
    res.json(outcomes);
  } catch (err) {
    console.error('[deployment-outcomes] GET /export error:', err);
    res.status(500).json({ error: 'Failed to export outcomes' });
  }
});

// PATCH /outcome/:id — update an existing outcome
router.patch('/outcome/:id', async (req, res) => {
  try {
    const body = req.body as UpdateOutcomeInput;

    if (!body.result) {
      return res.status(400).json({ error: 'result is required' });
    }

    const validResults: DeploymentResult[] = ['success', 'downtime', 'rollback'];
    if (!validResults.includes(body.result)) {
      return res.status(400).json({ error: `result must be one of: ${validResults.join(', ')}` });
    }

    const outcome = await outcomeService.updateOutcome(req.params.id, body);
    if (!outcome) {
      return res.status(404).json({ error: 'Outcome not found' });
    }

    res.json(outcome);
  } catch (err) {
    console.error('[deployment-outcomes] PATCH /outcome/:id error:', err);
    res.status(500).json({ error: 'Failed to update deployment outcome' });
  }
});

// DELETE /outcome/:id — remove an outcome
router.delete('/outcome/:id', async (req, res) => {
  try {
    const deleted = await outcomeService.deleteOutcome(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Outcome not found' });
    }

    res.status(204).send();
  } catch (err) {
    console.error('[deployment-outcomes] DELETE /outcome/:id error:', err);
    res.status(500).json({ error: 'Failed to delete deployment outcome' });
  }
});

// GET /by-release/:releaseVersion — outcomes for a specific release
router.get('/by-release/:releaseVersion', async (req, res) => {
  try {
    const outcomes = await outcomeService.getOutcomesByRelease(req.params.releaseVersion);
    res.json(outcomes);
  } catch (err) {
    console.error('[deployment-outcomes] GET /by-release error:', err);
    res.status(500).json({ error: 'Failed to fetch outcomes by release' });
  }
});

// GET /:deploymentId — outcome for a specific deployment
router.get('/:deploymentId', async (req, res) => {
  try {
    const outcome = await outcomeService.getOutcomeByDeployment(req.params.deploymentId);
    if (!outcome) {
      return res.status(404).json({ error: 'Outcome not found' });
    }
    res.json(outcome);
  } catch (err) {
    console.error('[deployment-outcomes] GET /:deploymentId error:', err);
    res.status(500).json({ error: 'Failed to fetch deployment outcome' });
  }
});

function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export default router;
