import { Router, Request, Response } from 'express';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  standupConfigs,
  standupSessions,
  standupParticipants,
  standupActionProposals,
  appGroups,
  appUsers,
} from '../db/schema';
import { requireAnyPermission, requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import { getAdoTokenForUser } from '../services/adoUserToken';
import { adoWriteFromToken, isAdoUserAuthError } from '../services/adoFactory';
import {
  submitParticipant,
  runFacilitator,
  triggerSessionForConfig,
  deleteStandupSession,
} from '../services/standupService';
import {
  evaluateCalendarItemHealth,
  normalizeDeliveryModel,
  normalizeGoalSource,
  recomputeSessionTeamPulse,
  resolveStandupPolicy,
  synthesizeTeamPulse,
  type EvidenceWorkItem,
} from '../services/standupDeliveryPolicyService';
import { collectAndSaveParticipantBrief } from '../services/standupEvidenceCollectorService';
import {
  STANDUP_DELIVERY_MODELS,
  STANDUP_GOAL_SOURCES,
  type CalendarDeliveryPulseResponse,
  type StandupActionProposal,
  type StandupActionProposalInput,
  type StandupDeliveryModel,
  type StandupDeliveryPolicy,
  type StandupGoalSource,
  type StandupStructuredUpdate,
  type StandupTeamPulse,
} from '../../shared/types/standup';

const router = Router();

async function buildDisplayNameMap(userIds: string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const map = new Map<string, string>();
  if (uniqueIds.length === 0 || !db.query.appUsers?.findMany) return map;
  try {
    const users = await db.query.appUsers.findMany({
      where: inArray(appUsers.oid, uniqueIds),
      columns: { oid: true, displayName: true },
    });
    for (const user of users) {
      if (user.displayName) map.set(user.oid, user.displayName);
    }
  } catch {
    // Optional display-name enrichment
  }
  return map;
}

async function buildDeliveryPulseResponse(
  project: string,
  workItems: EvidenceWorkItem[] = [],
): Promise<CalendarDeliveryPulseResponse> {
  const configs = db.query.standupConfigs?.findMany
    ? await db.query.standupConfigs.findMany({
        where: eq(standupConfigs.project, project),
        orderBy: desc(standupConfigs.createdAt),
      })
    : [];

  const activeConfig =
    configs.find((c) => c.enabled) ?? configs[0] ?? null;

  const deliveryModel: StandupDeliveryModel = normalizeDeliveryModel(
    activeConfig?.deliveryModel,
  );
  const goalSource: StandupGoalSource = normalizeGoalSource(
    activeConfig?.goalSource,
  );
  const teamGoal = activeConfig?.teamGoal ?? null;
  const resolvedPolicy = resolveStandupPolicy(deliveryModel, activeConfig?.policy);

  let latestSession: {
    id: string;
    sessionDate: string;
    teamPulse?: StandupTeamPulse | null;
    participants?: Array<{
      userId: string;
      status: string;
      structuredUpdate?: StandupStructuredUpdate | null;
      preparedBrief?: import('../../shared/types/standup').ParticipantPreparedBrief | null;
    }>;
  } | null = null;

  if (configs.length > 0 && db.query.standupSessions?.findMany) {
    const configIds = configs.map((c) => c.id);
    const sessions = await db.query.standupSessions.findMany({
      where: inArray(standupSessions.configId, configIds),
      with: { participants: true },
      orderBy: [desc(standupSessions.sessionDate), desc(standupSessions.createdAt)],
      limit: 1,
    });
    latestSession = sessions[0] ?? null;
  }

  const proposals: StandupActionProposal[] = db.query.standupActionProposals?.findMany
    ? ((await db.query.standupActionProposals.findMany({
        where: and(
          eq(standupActionProposals.project, project),
          eq(standupActionProposals.status, 'pending'),
        ),
        orderBy: desc(standupActionProposals.createdAt),
      })) as StandupActionProposal[])
    : [];

  let teamPulse: StandupTeamPulse | null = latestSession?.teamPulse ?? null;
  if (!teamPulse && latestSession?.participants) {
    const nameMap = await buildDisplayNameMap(
      latestSession.participants.map((p) => p.userId),
    );
    teamPulse = synthesizeTeamPulse({
      deliveryModel,
      teamGoal,
      participants: latestSession.participants.map((p) => ({
        userId: p.userId,
        displayName: nameMap.get(p.userId) ?? null,
        status: p.status,
        structuredUpdate: p.structuredUpdate ?? null,
        preparedBrief: p.preparedBrief ?? null,
      })),
      proposals,
    });
  }

  const evaluated = evaluateCalendarItemHealth(workItems, {
    deliveryModel,
    policy: resolvedPolicy,
    expectedIterationPath: activeConfig?.iterationPath ?? null,
    teamPulse,
    proposals,
  });

  return {
    project,
    deliveryModel,
    teamGoal,
    goalSource,
    enableTargetDateChecks: resolvedPolicy.enableTargetDateChecks,
    staleDaysThreshold: resolvedPolicy.staleDaysThreshold,
    wipLimitPerPerson: resolvedPolicy.wipLimitPerPerson,
    slaHoursHighPriority: resolvedPolicy.slaHoursHighPriority,
    latestSessionId: latestSession?.id ?? null,
    latestSessionDate: latestSession?.sessionDate ?? null,
    overallHealth: evaluated.overallHealth,
    counts: evaluated.counts,
    itemHealthById: evaluated.itemHealthById,
    proposals,
    teamPulse,
  };
}

// ── Calendar & Cross-Surface Delivery Pulse Routes ───────────────────────────

router.get(
  '/delivery-pulse',
  requireAnyPermission('standup:participate', 'calendar:view'),
  async (req: Request, res: Response) => {
    try {
      const project =
        typeof req.query.project === 'string' ? req.query.project.trim() : '';
      if (!project) {
        res.status(400).json({ error: 'project query parameter is required' });
        return;
      }
      const response = await buildDeliveryPulseResponse(project, []);
      res.json(response);
    } catch (err) {
      console.error('[standup] GET /delivery-pulse failed:', (err as Error).message);
      res.status(500).json({ error: 'Failed to load delivery pulse' });
    }
  },
);

router.post(
  '/delivery-pulse/evaluate',
  requireAnyPermission('standup:participate', 'calendar:view'),
  async (req: Request, res: Response) => {
    try {
      const { project, workItems } = req.body as {
        project?: string;
        workItems?: EvidenceWorkItem[];
      };
      if (!project || typeof project !== 'string') {
        res.status(400).json({ error: 'project is required' });
        return;
      }
      const response = await buildDeliveryPulseResponse(
        project.trim(),
        Array.isArray(workItems) ? workItems : [],
      );
      res.json(response);
    } catch (err) {
      console.error('[standup] POST /delivery-pulse/evaluate failed:', (err as Error).message);
      res.status(500).json({ error: 'Failed to evaluate delivery pulse' });
    }
  },
);

// ── Confirmation-Gated ADO Proposal Actions ──────────────────────────────────

router.post(
  '/proposals/:id/apply',
  requirePermission('workitems:write'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const proposal = await db.query.standupActionProposals.findFirst({
        where: eq(standupActionProposals.id, id),
      });
      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      if (proposal.status !== 'pending') {
        res.status(400).json({ error: `Proposal is already ${proposal.status}` });
        return;
      }

      const shouldWriteAdo =
        process.env.E2E_MODE !== 'true' &&
        (process.env.NODE_ENV === 'production' || Boolean(process.env.ADO_ORG_URL && process.env.ADO_PAT));

      if (shouldWriteAdo) {
        const token = await getAdoTokenForUser(req);
        const adoService = adoWriteFromToken(token, proposal.project);
        await adoService.updateWorkItemField(
          proposal.workItemId,
          proposal.fieldName,
          proposal.proposedValue,
        );
      }

      const now = new Date().toISOString();
      const decidedBy = getUserId(req);
      const [updated] = await db
        .update(standupActionProposals)
        .set({
          status: 'applied',
          decidedBy,
          decidedAt: now,
        })
        .where(eq(standupActionProposals.id, id))
        .returning();

      await recomputeSessionTeamPulse(proposal.sessionId).catch((err) =>
        console.warn('[standup] Pulse recompute after apply skipped:', (err as Error).message),
      );

      res.json({ ok: true, proposal: updated });
    } catch (err) {
      if (isAdoUserAuthError(err)) {
        res.status(403).json({ error: err.message });
        return;
      }
      console.error('[standup] POST /proposals/:id/apply failed:', (err as Error).message);
      res.status(500).json({ error: 'Failed to apply proposal' });
    }
  },
);

router.post(
  '/proposals/:id/dismiss',
  requireAnyPermission('standup:participate', 'workitems:write'),
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const proposal = await db.query.standupActionProposals.findFirst({
        where: eq(standupActionProposals.id, id),
      });
      if (!proposal) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      if (proposal.status !== 'pending') {
        res.status(400).json({ error: `Proposal is already ${proposal.status}` });
        return;
      }

      const now = new Date().toISOString();
      const decidedBy = getUserId(req);
      const [updated] = await db
        .update(standupActionProposals)
        .set({
          status: 'dismissed',
          decidedBy,
          decidedAt: now,
        })
        .where(eq(standupActionProposals.id, id))
        .returning();

      await recomputeSessionTeamPulse(proposal.sessionId).catch((err) =>
        console.warn('[standup] Pulse recompute after dismiss skipped:', (err as Error).message),
      );

      res.json({ ok: true, proposal: updated });
    } catch (err) {
      console.error('[standup] POST /proposals/:id/dismiss failed:', (err as Error).message);
      res.status(500).json({ error: 'Failed to dismiss proposal' });
    }
  },
);

// All remaining standup routes require at least participate permission
router.use(requirePermission('standup:participate'));

// ── Config CRUD (manage permission) ──────────────────────────────────────────

router.get('/configs', requirePermission('standup:manage'), async (_req: Request, res: Response) => {
  try {
    const configs = await db.query.standupConfigs.findMany({
      with: { group: true, skillSettings: { columns: { id: true, friendlyName: true } } },
      orderBy: desc(standupConfigs.createdAt),
    });

    const allGroupIds = [...new Set(configs.flatMap((c) => (c.groupIds as string[]) ?? []))];
    const groupMap = new Map<string, { id: string; name: string }>();
    if (allGroupIds.length > 0) {
      const groupRows = await db
        .select({ id: appGroups.id, name: appGroups.name })
        .from(appGroups)
        .where(inArray(appGroups.id, allGroupIds));
      groupRows.forEach((g) => groupMap.set(g.id, g));
    }

    const enriched = configs.map((c) => {
      const model = normalizeDeliveryModel(c.deliveryModel);
      return {
        ...c,
        deliveryModel: model,
        goalSource: normalizeGoalSource(c.goalSource),
        policy: resolveStandupPolicy(model, c.policy),
        groups: ((c.groupIds as string[]) ?? []).map((id) => groupMap.get(id)).filter(Boolean),
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('[standup] GET /configs failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch standup configs' });
  }
});

router.post('/configs', requirePermission('standup:manage'), async (req: Request, res: Response) => {
  try {
    const {
      groupIds,
      project,
      areaPath,
      iterationMode,
      iterationPath,
      scheduleTime,
      timezone,
      weekdays,
      skillSettingsId,
      enabled,
      reminderDelayMin,
      reminderIntervalMin,
      facilitatorDeadlineMin,
      deliveryModel,
      goalSource,
      teamGoal,
      policy,
    } = req.body;

    if (!Array.isArray(groupIds) || groupIds.length === 0 || !project) {
      res.status(400).json({ error: 'groupIds (non-empty array) and project are required' });
      return;
    }
    if (
      deliveryModel !== undefined &&
      !(STANDUP_DELIVERY_MODELS as readonly string[]).includes(deliveryModel)
    ) {
      res.status(400).json({ error: `Invalid deliveryModel: ${String(deliveryModel)}` });
      return;
    }
    if (
      goalSource !== undefined &&
      !(STANDUP_GOAL_SOURCES as readonly string[]).includes(goalSource)
    ) {
      res.status(400).json({ error: `Invalid goalSource: ${String(goalSource)}` });
      return;
    }

    const resolvedModel = normalizeDeliveryModel(deliveryModel);
    const resolvedSource = normalizeGoalSource(goalSource);
    const resolvedPolicy =
      policy !== undefined
        ? resolveStandupPolicy(resolvedModel, policy as Partial<StandupDeliveryPolicy>)
        : undefined;

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
      ...(deliveryModel !== undefined ? { deliveryModel: resolvedModel } : {}),
      ...(goalSource !== undefined ? { goalSource: resolvedSource } : {}),
      ...(teamGoal !== undefined ? { teamGoal: teamGoal ?? null } : {}),
      ...(resolvedPolicy !== undefined ? { policy: resolvedPolicy } : {}),
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
    const updates = { ...req.body };

    if (
      updates.deliveryModel !== undefined &&
      !(STANDUP_DELIVERY_MODELS as readonly string[]).includes(updates.deliveryModel)
    ) {
      res.status(400).json({ error: `Invalid deliveryModel: ${String(updates.deliveryModel)}` });
      return;
    }
    if (
      updates.goalSource !== undefined &&
      !(STANDUP_GOAL_SOURCES as readonly string[]).includes(updates.goalSource)
    ) {
      res.status(400).json({ error: `Invalid goalSource: ${String(updates.goalSource)}` });
      return;
    }

    if (updates.policy !== undefined) {
      updates.policy = resolveStandupPolicy(
        updates.deliveryModel,
        updates.policy as Partial<StandupDeliveryPolicy>,
      );
    }

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

async function enrichSessionDetail(session: any) {
  if (!session) return null;

  const participants = Array.isArray(session.participants) ? session.participants : [];
  const nameMap = await buildDisplayNameMap(participants.map((p: any) => p.userId));
  const enrichedParticipants = participants.map((p: any) => ({
    ...p,
    displayName: p.displayName ?? nameMap.get(p.userId) ?? null,
  }));

  let proposals: StandupActionProposal[] = Array.isArray(session.proposals)
    ? session.proposals
    : [];
  if (!Array.isArray(session.proposals) && db.query.standupActionProposals?.findMany) {
    try {
      proposals = (await db.query.standupActionProposals.findMany({
        where: eq(standupActionProposals.sessionId, session.id),
        orderBy: desc(standupActionProposals.createdAt),
      })) as StandupActionProposal[];
    } catch {
      proposals = [];
    }
  }

  const deliveryModel = normalizeDeliveryModel(session.config?.deliveryModel);
  const teamGoal = session.config?.teamGoal ?? null;

  const teamPulse: StandupTeamPulse =
    session.teamPulse ??
    synthesizeTeamPulse({
      deliveryModel,
      teamGoal,
      participants: enrichedParticipants,
      proposals,
    });

  return {
    ...session,
    config: session.config
      ? {
          ...session.config,
          deliveryModel,
          goalSource: normalizeGoalSource(session.config.goalSource),
          policy: resolveStandupPolicy(deliveryModel, session.config.policy),
        }
      : session.config,
    participants: enrichedParticipants,
    proposals,
    teamPulse,
  };
}

router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const projectFilter =
      typeof req.query.project === 'string' && req.query.project.trim()
        ? req.query.project.trim()
        : null;

    const sessions = await db.query.standupSessions.findMany({
      with: { participants: true, followups: true, config: true },
      orderBy: desc(standupSessions.createdAt),
      limit: 50,
    });

    const filtered = projectFilter
      ? sessions.filter((s: any) => s.config?.project === projectFilter)
      : sessions;

    res.json(filtered);
  } catch (err) {
    console.error('[standup] GET /sessions failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

router.get('/sessions/latest', async (req: Request, res: Response) => {
  try {
    const projectFilter =
      typeof req.query.project === 'string' && req.query.project.trim()
        ? req.query.project.trim()
        : null;

    let configIds: string[] | null = null;
    if (projectFilter && db.query.standupConfigs?.findMany) {
      const configs = await db.query.standupConfigs.findMany({
        where: eq(standupConfigs.project, projectFilter),
      });
      configIds = configs.map((c) => c.id);
      if (configIds.length === 0) {
        res.json(null);
        return;
      }
    }

    const sessions = await db.query.standupSessions.findMany({
      ...(configIds ? { where: inArray(standupSessions.configId, configIds) } : {}),
      with: { participants: true, followups: true, proposals: true, config: true },
      orderBy: [desc(standupSessions.sessionDate), desc(standupSessions.createdAt)],
      limit: 1,
    });

    const latest = sessions[0] ?? null;
    if (!latest) {
      res.json(null);
      return;
    }

    res.json(await enrichSessionDetail(latest));
  } catch (err) {
    console.error('[standup] GET /sessions/latest failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch latest session' });
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
      with: { participants: true, followups: true, proposals: true, config: true },
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(await enrichSessionDetail(session));
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
    const projectFilter =
      typeof req.query.project === 'string' && req.query.project.trim()
        ? req.query.project.trim()
        : null;

    const participants = await db.query.standupParticipants.findMany({
      where: eq(standupParticipants.userId, userId),
      with: {
        session: {
          with: { config: true },
        },
        proposals: true,
      },
    });

    const todaysParticipants = participants.filter(
      (p) => p.session?.sessionDate === today,
    );
    const participant =
      (projectFilter
        ? todaysParticipants.find((p) => p.session?.config?.project === projectFilter)
        : undefined) ?? todaysParticipants[0];

    if (!participant) {
      res.json(null);
      return;
    }

    let preparedBrief = participant.preparedBrief ?? null;
    if (!preparedBrief) {
      preparedBrief = await collectAndSaveParticipantBrief(participant.id).catch(
        () => null,
      );
    }

    const rawConfig = participant.session?.config;
    const deliveryModel = normalizeDeliveryModel(rawConfig?.deliveryModel);

    res.json({
      participantId: participant.id,
      sessionId: participant.sessionId,
      threadId: participant.threadId,
      status: participant.status,
      sessionDate: participant.session.sessionDate,
      sessionStatus: participant.session.status,
      config: rawConfig
        ? {
            id: rawConfig.id,
            project: rawConfig.project,
            areaPath: rawConfig.areaPath ?? null,
            deliveryModel,
            goalSource: normalizeGoalSource(rawConfig.goalSource),
            teamGoal: rawConfig.teamGoal ?? null,
            policy: resolveStandupPolicy(deliveryModel, rawConfig.policy),
          }
        : {
            id: '',
            project: projectFilter ?? '',
            areaPath: null,
            deliveryModel: 'flow' as const,
            goalSource: 'none' as const,
            teamGoal: null,
            policy: resolveStandupPolicy('flow'),
          },
      preparedBrief,
      structuredUpdate: participant.structuredUpdate ?? null,
      proposals: Array.isArray(participant.proposals) ? participant.proposals : [],
    });
  } catch (err) {
    console.error('[standup] GET /my-session failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to fetch my session' });
  }
});

// ── Refresh Participant Brief ────────────────────────────────────────────────

router.post('/participants/:id/refresh-brief', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const preparedBrief = await collectAndSaveParticipantBrief(id);
    if (!preparedBrief) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }
    res.json({ ok: true, preparedBrief });
  } catch (err) {
    console.error('[standup] POST /participants/:id/refresh-brief failed:', (err as Error).message);
    res.status(500).json({ error: 'Failed to refresh participant brief' });
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
    const { structuredUpdate, proposals } = (req.body ?? {}) as {
      structuredUpdate?: StandupStructuredUpdate | null;
      proposals?: StandupActionProposalInput[];
    };
    const hasQuickPayload =
      structuredUpdate !== undefined || (Array.isArray(proposals) && proposals.length > 0);
    if (hasQuickPayload) {
      await submitParticipant(id, { structuredUpdate, proposals });
    } else {
      await submitParticipant(id);
    }
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
