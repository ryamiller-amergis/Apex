/**
 * ServiceNow incident triage routes. Mounted at /api/incident-triage after ensureAuthenticated.
 * Every route needs project access plus an incident-triage permission, behind one flag split.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  requirePermission,
  requireProjectAccess,
  resolveRequestProject,
} from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { isFeatureEnabled } from '../services/featureFlagService';
import {
  defaultSettings,
  getIncidentDetail,
  getSettings,
  listIncidents,
  upsertSettings,
} from '../services/incidentTriageStore';
import { requestIncidentAnalysis } from '../services/incidentTriageRuns';
import { IncidentTriageSweepUnavailableError, sweepProject } from '../services/incidentTriageSweep';
import { sendIncidentTriageTestCard } from '../services/incidentTriageTeams';
import { isTeamsWorkflowsWebhookUrl } from '../services/incidentTriageWebhookCrypto';
import { ServiceNowRequestError } from '../services/serviceNowClient';
import { INCIDENT_TRIAGE_FLAG } from '../../shared/types/featureFlags';
import {
  INCIDENT_TRIAGE_PERMISSIONS,
  INCIDENT_TRIAGE_VERDICTS,
  type IncidentTriageListResponse,
  type IncidentTriageSettingsUpdate,
  type IncidentTriageVerdict,
} from '../../shared/types/incidentTriage';

const router = Router();

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_QUERY_LENGTH = 200;
const MAX_ASSIGNMENT_GROUPS = 20;
const MIN_BACKFILL_DAYS = 1;
const MAX_BACKFILL_DAYS = 30;
const INVALID_WEBHOOK_MESSAGE = 'Webhook must be a Teams Workflows URL';
const SYS_ID = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { view, run, manage } = INCIDENT_TRIAGE_PERMISSIONS;
const access = requireProjectAccess(resolveRequestProject);

function projectOf(req: Request): string {
  return resolveRequestProject(req) as string;
}

function queryString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseLimit(value: unknown): number {
  const parsed = Number(queryString(value));
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(parsed, MAX_LIST_LIMIT);
}

function isVerdict(value: string): value is IncidentTriageVerdict {
  return (INCIDENT_TRIAGE_VERDICTS as readonly string[]).includes(value);
}

type SettingsParse = { update: IncidentTriageSettingsUpdate } | { error: string };

function parseSettingsUpdate(body: Record<string, unknown>): SettingsParse {
  const update: IncidentTriageSettingsUpdate = {};

  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    update.enabled = body.enabled;
  }

  if (body.assignmentGroupIds !== undefined) {
    const ids = body.assignmentGroupIds;
    if (!Array.isArray(ids) || ids.length > MAX_ASSIGNMENT_GROUPS) {
      return { error: `assignmentGroupIds must be an array of at most ${MAX_ASSIGNMENT_GROUPS} sys_ids` };
    }
    if (!ids.every((id) => typeof id === 'string' && SYS_ID.test(id))) {
      return { error: 'assignmentGroupIds must be 32-character hex sys_ids' };
    }
    update.assignmentGroupIds = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
  }

  if (body.backfillDays !== undefined) {
    const days = body.backfillDays;
    if (
      typeof days !== 'number'
      || !Number.isInteger(days)
      || days < MIN_BACKFILL_DAYS
      || days > MAX_BACKFILL_DAYS
    ) {
      return { error: `backfillDays must be a whole number from ${MIN_BACKFILL_DAYS} to ${MAX_BACKFILL_DAYS}` };
    }
    update.backfillDays = days;
  }

  if (body.teamsWebhookUrl !== undefined) {
    const url = body.teamsWebhookUrl;
    if (url === null) {
      update.teamsWebhookUrl = null;
    } else {
      const trimmed = typeof url === 'string' ? url.trim() : '';
      if (!isTeamsWorkflowsWebhookUrl(trimmed)) return { error: INVALID_WEBHOOK_MESSAGE };
      update.teamsWebhookUrl = trimmed;
    }
  }

  if (Object.keys(update).length === 0) return { error: 'No settings to update' };
  return { update };
}

router.use(async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const project = resolveRequestProject(req);
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const enabled = await isFeatureEnabled(INCIDENT_TRIAGE_FLAG, { userId: getUserId(req), project });
    // @feature-flag:servicenow-incident-triage start winner=enabled
    if (!enabled) {
      // @feature-flag:servicenow-incident-triage disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:servicenow-incident-triage disabled-end
    }
    // @feature-flag:servicenow-incident-triage enabled-start
    next();
    // @feature-flag:servicenow-incident-triage enabled-end
    // @feature-flag:servicenow-incident-triage end
  } catch (err) {
    next(err);
  }
});

router.get('/incidents', access, requirePermission(view), async (req, res, next) => {
  try {
    const verdict = queryString(req.query.verdict);
    if (verdict !== undefined && !isVerdict(verdict)) {
      res.status(400).json({ error: 'Unknown verdict' });
      return;
    }
    const incidents = await listIncidents(projectOf(req), {
      verdict,
      state: queryString(req.query.state),
      q: queryString(req.query.q)?.slice(0, MAX_QUERY_LENGTH),
      limit: parseLimit(req.query.limit),
    });
    const body: IncidentTriageListResponse = { incidents };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

router.get('/incidents/:id', access, requirePermission(view), async (req, res, next) => {
  try {
    const id = req.params.id;
    const detail = UUID.test(id) ? await getIncidentDetail(projectOf(req), id) : null;
    if (!detail) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

router.post('/incidents/:id/analyze', access, requirePermission(run), async (req, res, next) => {
  try {
    const id = req.params.id;
    const outcome = UUID.test(id)
      ? await requestIncidentAnalysis({ project: projectOf(req), incidentId: id, requestedBy: getUserId(req) })
      : { status: 'not_found' as const };
    switch (outcome.status) {
      case 'admitted':
        res.json({ runId: outcome.runId });
        return;
      case 'already_running':
        res.status(409).json({ error: 'An analysis for this incident is already running' });
        return;
      case 'not_found':
        res.status(404).json({ error: 'Not found' });
        return;
    }
  } catch (err) {
    next(err);
  }
});

router.post('/sweep', access, requirePermission(run), async (req, res, next) => {
  try {
    const counts = await sweepProject(projectOf(req), { requestedBy: getUserId(req) });
    res.json(counts);
  } catch (err) {
    if (err instanceof IncidentTriageSweepUnavailableError) {
      res.status(err.reason === 'not_enabled' ? 409 : 503).json({ error: err.message });
      return;
    }
    if (err instanceof ServiceNowRequestError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

router.get('/settings', access, requirePermission(manage), async (req, res, next) => {
  try {
    const project = projectOf(req);
    res.json((await getSettings(project)) ?? defaultSettings(project));
  } catch (err) {
    next(err);
  }
});

router.put('/settings', access, requirePermission(manage), async (req, res, next) => {
  try {
    const parsed = parseSettingsUpdate((req.body ?? {}) as Record<string, unknown>);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    res.json(await upsertSettings(projectOf(req), parsed.update, getUserId(req)));
  } catch (err) {
    next(err);
  }
});

router.post('/settings/test-post', access, requirePermission(manage), async (req, res, next) => {
  try {
    const project = projectOf(req);
    const settings = await getSettings(project);
    if (!settings?.teamsWebhookMasked) {
      res.status(409).json({ error: 'No Teams webhook is set for this project' });
      return;
    }
    const outcome = await sendIncidentTriageTestCard(project);
    if (outcome.ok) {
      res.json({ ok: true });
      return;
    }
    res.status(502).json({ error: outcome.status === null ? 'Teams did not respond' : `Teams returned ${outcome.status}` });
  } catch (err) {
    next(err);
  }
});

export default router;
