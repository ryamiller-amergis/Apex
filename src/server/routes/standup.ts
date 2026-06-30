import { Router, Request, Response } from 'express';
import { eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  standupConfigs,
  standupSessions,
  standupParticipants,
  standupFollowups,
  appGroups,
} from '../db/schema';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { getAdoTokenForUser } from '../services/adoUserToken';
import {
  submitParticipant,
  runFacilitator,
  triggerSessionForConfig,
  deleteStandupSession,
} from '../services/standupService';

const router = Router();

// All standup routes require at least participate permission
router.use(requirePermission('standup:participate'));

// ── Config CRUD (manage permission) ──────────────────────────────────────────

router.get('/configs', requirePermission('standup:manage'), async (_req: Request, res: Response) => {
  try {
    const configs = await db.query.standupConfigs.findMany({
      with: { group: true, skillSettings: { columns: { id: true, friendlyName: true } } },
      orderBy: desc(standupConfigs.createdAt),
    });

    // Enrich each config with the full group objects for its groupIds array
    const allGroupIds = [...new Set(configs.flatMap((c) => (c.groupIds as string[]) ?? []))];
    const groupMap = new Map<string, { id: string; name: string }>();
    if (allGroupIds.length > 0) {
      const groupRows = await db
        .select({ id: appGroups.id, name: appGroups.name })
        .from(appGroups)
        .where(inArray(appGroups.id, allGroupIds));
      groupRows.forEach((g) => groupMap.set(g.id, g));
    }

    const enriched = configs.map((c) => ({
      ...c,
      groups: ((c.groupIds as string[]) ?? []).map((id) => groupMap.get(id)).filter(Boolean),
    }));

    res.json(enriched);
  } catch (err) {
    console.error('[standup] GET /configs failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch standup configs' });
  }
});

router.post('/configs', requirePermission('standup:manage'), async (req: Request, res: Response) => {
  try {
    const { groupIds, project, areaPath, iterationMode, iterationPath, scheduleTime, timezone, weekdays, skillSettingsId, enabled, reminderDelayMin, reminderIntervalMin, facilitatorDeadlineMin } = req.body;
    if (!Array.isArray(groupIds) || groupIds.length === 0 || !project) {
      res.status(400).json({ error: 'groupIds (non-empty array) and project are required' });
      return;
    }
    const [row] = await db.insert(standupConfigs).values({
      groupIds,
      project,
      areaPath: areaPath ?? null,
      iterationMode: iterationMode ?? 'current',
      iterationPath: iterationPath ?? null,
      scheduleTime: scheduleTime ?? '09:00',
      timezone: timezone ?? 'America/New_York',
      weekdays: weekdays ?? [1, 2, 3, 4, 5],
      skillSettingsId: skillSettingsId ?? null,
      enabled: enabled ?? true,
      ...(reminderDelayMin != null ? { reminderDelayMin } : {}),
      ...(reminderIntervalMin != null ? { reminderIntervalMin } : {}),
      ...(facilitatorDeadlineMin != null ? { facilitatorDeadlineMin } : {}),
    }).returning();
    res.status(201).json(row);
  } catch (err) {
    console.error('[standup] POST /configs failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to create standup config' });
  }
});

router.put('/configs/:id', requirePermission('standup:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const now = new Date().toISOString();
    const [row] = await db
      .update(standupConfigs)
      .set({ ...updates, updatedAt: now })
      .where(eq(standupConfigs.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: 'Config not found' });
      return;
    }
    res.json(row);
  } catch (err) {
    console.error('[standup] PUT /configs/:id failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to update standup config' });
  }
});

router.delete('/configs/:id', requirePermission('standup:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await db.delete(standupConfigs).where(eq(standupConfigs.id, id));
    res.json({ ok: true });
  } catch (err) {
    console.error('[standup] DELETE /configs/:id failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to delete standup config' });
  }
});

// ── Sessions ─────────────────────────────────────────────────────────────────

router.get('/sessions', async (_req: Request, res: Response) => {
  try {
    const sessions = await db.query.standupSessions.findMany({
      with: { participants: true, followups: true },
      orderBy: desc(standupSessions.createdAt),
      limit: 50,
    });
    res.json(sessions);
  } catch (err) {
    console.error('[standup] GET /sessions failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

router.delete('/sessions/:id', requirePermission('standup:manage'), async (req: Request, res: Response) => {
  try {
    await deleteStandupSession(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'Session not found') {
      res.status(404).json({ error: message });
      return;
    }
    console.error('[standup] DELETE /sessions/:id failed:', message);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

router.get('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const session = await db.query.standupSessions.findFirst({
      where: eq(standupSessions.id, req.params.id),
      with: { participants: true, followups: true, config: true },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session);
  } catch (err) {
    console.error('[standup] GET /sessions/:id failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// ── My Session (current user's today participant) ─────────────────────────────

router.get('/my-session', async (req: Request, res: Response) => {
  try {
    const userId = getUserId(req);
    const today = new Date().toISOString().slice(0, 10);

    // A user may have participant rows across multiple days; pick today's.
    const participants = await db.query.standupParticipants.findMany({
      where: eq(standupParticipants.userId, userId),
      with: { session: true },
    });

    const participant = participants.find((p) => p.session.sessionDate === today);

    if (!participant) {
      res.json(null);
      return;
    }

    res.json({
      participantId: participant.id,
      sessionId: participant.sessionId,
      threadId: participant.threadId,
      status: participant.status,
      sessionDate: participant.session.sessionDate,
      sessionStatus: participant.session.status,
    });
  } catch (err) {
    console.error('[standup] GET /my-session failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch my session' });
  }
});

// ── Token Sync ───────────────────────────────────────────────────────────────

router.post('/threads/:threadId/sync-token', async (req: Request, res: Response) => {
  try {
    const { threadId } = req.params;
    const token = await getAdoTokenForUser(req);
    if (!token) {
      res.status(403).json({ error: 'Could not acquire ADO token' });
      return;
    }

    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString(); // ~55 min
    await db
      .update(standupParticipants)
      .set({ adoAccessToken: token, adoTokenExpiresAt: expiresAt })
      .where(eq(standupParticipants.threadId, threadId));

    res.json({ ok: true, expiresAt });
  } catch (err) {
    console.error('[standup] POST /threads/:threadId/sync-token failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to sync token' });
  }
});

// ── Submit ────────────────────────────────────────────────────────────────────

router.post('/participants/:id/submit', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await submitParticipant(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[standup] POST /participants/:id/submit failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to submit' });
  }
});

// ── Manual Trigger ────────────────────────────────────────────────────────────

router.post('/configs/:id/trigger', requirePermission('standup:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const result = await triggerSessionForConfig(id);
    res.json(result);
  } catch (err) {
    console.error('[standup] POST /configs/:id/trigger failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Manual Facilitate ─────────────────────────────────────────────────────────

router.post('/sessions/:id/facilitate', requirePermission('standup:manage'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await runFacilitator(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[standup] POST /sessions/:id/facilitate failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to trigger facilitator' });
  }
});

export default router;
