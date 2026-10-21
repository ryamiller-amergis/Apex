import { Router, type Request, type Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { requirePermission, requireProjectAccess, resolveRequestProject } from '../middleware/rbac';
import { getHomeDashboard } from '../services/homeDashboardService';
import { getUserEmail, getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';
import type { HomeDashboardScope } from '../../shared/types/homeDashboard';
import { CLOUD_AGENT_GUIDED_LAUNCH_FLAG, MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import { isFeatureEnabled } from '../services/featureFlagService';
import { db } from '../db/drizzle';
import { agentRuns, devSessions } from '../db/schema';
import { fetchAvailableModels } from '../services/modelsService';
import {
  GUIDED_CLOUD_JOBS,
  installedSkillPath,
  parseCloudAgentLaunchIntent,
} from '../../shared/utils/cloudAgentLaunch';
import {
  cancelCloudAgentRun,
  CloudAgentConflictError,
  CloudAgentEligibilityError,
  CloudAgentLaunchError,
  getCloudAgentActivityStream,
  listGuidedCloudAgentRuns,
  loadCloudAgentSkillChoices,
  startGuidedCloudAgentRun,
} from '../services/cloudAgentService';
import { startSseHeartbeat, writeSseEvent } from '../utils/sseResponse';

const router = Router();

// GET /api/home-dashboard — tile payload for the authenticated user in one project.
// Per-tile permission gates live in the service; this route only enforces access
// to the dashboard itself.
router.get(
  '/',
  requirePermission('home:view'),
  requireProjectAccess(resolveRequestProject),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req);
    // Super admins bypass requireProjectAccess, including its `all` sentinel check,
    // but the dashboard is always scoped to a single project.
    if (!project || project === 'all') {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    try {
      const scope: HomeDashboardScope = req.query.scope === 'mine' ? 'mine' : 'team';
      const payload = await getHomeDashboard({
        userId: getUserId(req),
        project,
        isSuperAdmin: isSuperAdminRequest(req),
        scope,
      });
      res.json(payload);
    } catch (err) {
      console.error('[home-dashboard] GET / error:', err);
      res.status(500).json({ error: 'Failed to fetch home dashboard' });
    }
  },
);

async function guidedLaunchAvailable(userId: string, project: string): Promise<boolean> {
  const [chooser, cloud] = await Promise.all([
    isFeatureEnabled(CLOUD_AGENT_GUIDED_LAUNCH_FLAG, { userId, project }),
    isFeatureEnabled(MY_WORK_CLOUD_AGENT_FLAG, { userId, project }),
  ]);
  return chooser && cloud;
}

router.get(
  '/cloud-agent/guided',
  requirePermission('chat:create'),
  requireProjectAccess(resolveRequestProject),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req);
    if (!project || project === 'all') {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled(CLOUD_AGENT_GUIDED_LAUNCH_FLAG, { userId, project });
    // @feature-flag:cloud-agent-guided-launch start winner=enabled
    if (!enabled) {
      // @feature-flag:cloud-agent-guided-launch disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:cloud-agent-guided-launch disabled-end
    }

    // @feature-flag:cloud-agent-guided-launch enabled-start
    if (!(await isFeatureEnabled(MY_WORK_CLOUD_AGENT_FLAG, { userId, project }))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    try {
      const [skills, models, runs] = await Promise.all([
        loadCloudAgentSkillChoices(project),
        fetchAvailableModels().catch(() => []),
        listGuidedCloudAgentRuns(userId, project),
      ]);
      res.json({
        jobs: GUIDED_CLOUD_JOBS.map((job) => ({
          ...job,
          skillPath: installedSkillPath(skills, job.skillName),
        })),
        skills,
        models,
        runs,
      });
    } catch (err) {
      console.error('[home-dashboard] guided jobs failed:', err);
      res.status(500).json({ error: 'Failed to load guided jobs' });
    }
    // @feature-flag:cloud-agent-guided-launch enabled-end
    // @feature-flag:cloud-agent-guided-launch end
  },
);

router.post(
  '/cloud-agent/guided',
  requirePermission('chat:create'),
  requireProjectAccess(resolveRequestProject),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req);
    if (!project || project === 'all') {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled(CLOUD_AGENT_GUIDED_LAUNCH_FLAG, { userId, project });
    // @feature-flag:cloud-agent-guided-launch start winner=enabled
    if (!enabled) {
      // @feature-flag:cloud-agent-guided-launch disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:cloud-agent-guided-launch disabled-end
    }

    // @feature-flag:cloud-agent-guided-launch enabled-start
    if (!(await isFeatureEnabled(MY_WORK_CLOUD_AGENT_FLAG, { userId, project }))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    try {
      const body = req.body as {
        jobId?: unknown;
        task?: unknown;
        intent?: unknown;
        sessionId?: unknown;
        skillPath?: unknown;
        model?: unknown;
      };
      const intent = parseCloudAgentLaunchIntent(body.intent);
      if (!intent) {
        res.status(400).json({ error: 'intent must be start, resume, or retry' });
        return;
      }
      const [skills, models] = await Promise.all([
        loadCloudAgentSkillChoices(project),
        fetchAvailableModels().catch(() => []),
      ]);
      const displayName = (req.user as { profile?: { displayName?: string } } | undefined)?.profile?.displayName;
      const result = await startGuidedCloudAgentRun({
        userId,
        project,
        jobId: typeof body.jobId === 'string' ? body.jobId : '',
        task: typeof body.task === 'string' ? body.task : '',
        intent,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        skillPath: typeof body.skillPath === 'string' ? body.skillPath : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        availableSkills: skills,
        allowedModelIds: models.map((model) => model.id),
        initiatorName: displayName,
        initiatorEmail: getUserEmail(req),
      });
      res.json(result);
    } catch (err) {
      if (err instanceof CloudAgentLaunchError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof CloudAgentEligibilityError) {
        res.status(403).json({ error: err.reason });
        return;
      }
      if (err instanceof CloudAgentConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error('[home-dashboard] guided start failed:', err);
      res.status(500).json({ error: 'Failed to start guided job' });
    }
    // @feature-flag:cloud-agent-guided-launch enabled-end
    // @feature-flag:cloud-agent-guided-launch end
  },
);

router.post(
  '/cloud-agent/guided/:sessionId/cancel',
  requirePermission('chat:create'),
  requireProjectAccess(resolveRequestProject),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req);
    if (!project || project === 'all') {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const userId = getUserId(req);
    const enabled = await isFeatureEnabled(CLOUD_AGENT_GUIDED_LAUNCH_FLAG, { userId, project });
    // @feature-flag:cloud-agent-guided-launch start winner=enabled
    if (!enabled) {
      // @feature-flag:cloud-agent-guided-launch disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:cloud-agent-guided-launch disabled-end
    }

    // @feature-flag:cloud-agent-guided-launch enabled-start
    if (!(await guidedLaunchAvailable(userId, project))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    try {
      const owned = await db
        .select({ id: devSessions.id, currentRunId: devSessions.currentRunId })
        .from(devSessions)
        .where(and(
          eq(devSessions.id, req.params.sessionId),
          eq(devSessions.authorId, userId),
          eq(devSessions.project, project),
        ))
        .limit(1);
      if (!owned[0]?.currentRunId) {
        res.status(404).json({ error: 'Guided job not found' });
        return;
      }
      const result = await cancelCloudAgentRun(req.params.sessionId, userId);
      res.json(result);
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 404) {
        res.status(404).json({ error: 'Guided job not found' });
        return;
      }
      if (err instanceof CloudAgentConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      console.error('[home-dashboard] guided cancel failed:', err);
      res.status(500).json({ error: 'Failed to cancel guided job' });
    }
    // @feature-flag:cloud-agent-guided-launch enabled-end
    // @feature-flag:cloud-agent-guided-launch end
  },
);

router.get(
  '/cloud-agent/guided/:sessionId/stream',
  requirePermission('chat:create'),
  requireProjectAccess(resolveRequestProject),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req);
    const userId = getUserId(req);
    const enabled = project
      ? await isFeatureEnabled(CLOUD_AGENT_GUIDED_LAUNCH_FLAG, { userId, project })
      : false;
    // @feature-flag:cloud-agent-guided-launch start winner=enabled
    if (!enabled || !project) {
      // @feature-flag:cloud-agent-guided-launch disabled-start
      res.status(404).json({ error: 'Not found' });
      return;
      // @feature-flag:cloud-agent-guided-launch disabled-end
    }

    // @feature-flag:cloud-agent-guided-launch enabled-start
    if (!(await guidedLaunchAvailable(userId, project))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    let iterator: AsyncIterator<unknown> | null = null;
    let stopHeartbeat: (() => void) | null = null;
    let closed = false;
    req.on('close', () => {
      closed = true;
      stopHeartbeat?.();
      void iterator?.return?.();
    });
    try {
      const runId = typeof req.query.runId === 'string' ? req.query.runId : undefined;
      const owned = await db
        .select({ currentRunId: devSessions.currentRunId })
        .from(devSessions)
        .where(and(
          eq(devSessions.id, req.params.sessionId),
          eq(devSessions.authorId, userId),
          eq(devSessions.project, project),
        ))
        .limit(1);
      if (!owned[0]?.currentRunId) {
        res.status(404).json({ error: 'Guided job not found' });
        return;
      }
      const run = await db.query.agentRuns.findFirst({
        where: eq(agentRuns.id, owned[0].currentRunId),
      });
      const delivery = run?.executionSnapshot && 'cloudAgent' in run.executionSnapshot
        ? run.executionSnapshot.cloudAgent?.delivery
        : undefined;
      if (delivery !== 'guided') {
        res.status(404).json({ error: 'Guided job not found' });
        return;
      }
      const stream = await getCloudAgentActivityStream(req.params.sessionId, userId, runId);
      iterator = stream[Symbol.asyncIterator]();
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      stopHeartbeat = startSseHeartbeat(res);
      while (!closed) {
        const next = await iterator.next();
        if (next.done) break;
        if (!writeSseEvent(res, { type: 'activity', event: next.value })) break;
      }
      if (!closed) {
        writeSseEvent(res, { type: 'stream_end' });
        res.end();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cloud Agent activity stream failed';
      if (res.headersSent) {
        writeSseEvent(res, { type: 'stream_error', error: message });
        res.end();
      } else {
        const status = (err as Error & { status?: number }).status ?? 500;
        res.status(status).json({
          error: status === 500 ? 'Failed to stream Cloud Agent activity' : message,
        });
      }
    } finally {
      stopHeartbeat?.();
    }
    // @feature-flag:cloud-agent-guided-launch enabled-end
    // @feature-flag:cloud-agent-guided-launch end
  },
);

export default router;
