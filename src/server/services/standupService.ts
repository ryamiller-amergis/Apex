import { eq, and, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/drizzle';
import {
  standupConfigs,
  standupSessions,
  standupParticipants,
  standupFollowups,
  standupActionProposals,
  chatMessages,
  projectSkillWorkflowSettings,
} from '../db/schema';
import { createThread } from './chatAgentService';
import { deleteThread } from './chatThreadRepository';
import { createNotification } from './notificationService';
import { sendTeamsNotification } from './teamsBotService';
import {
  normalizeDeliveryModel,
  normalizeGoalSource,
  normalizeRosterMode,
  recomputeSessionTeamPulse,
} from './standupDeliveryPolicyService';
import {
  collectAndSaveParticipantBrief,
  resolveStandupRoster,
} from './standupEvidenceCollectorService';
import type { ChatThreadKickoff } from '../../shared/types/chat';
import type {
  StandupActionProposalInput,
  StandupApprovalAction,
  StandupItemDecision,
  StandupRejectedItemRecord,
  StandupStructuredUpdate,
} from '../../shared/types/standup';

// The standup skill path lives on project_skill_workflow_settings. The parent
// row only still has the repo and branch.
const standupSkillSettings = {
  columns: {
    skillRepo: true,
    skillBranch: true,
  },
  with: {
    workflowSettings: {
      where: eq(projectSkillWorkflowSettings.workflow, 'standup'),
      columns: { skillPath: true },
    },
  },
};

// ── Reminders ─────────────────────────────────────────────────────────────────

export async function sendStandupReminders(sessionId: string): Promise<void> {
  const session = await db.query.standupSessions.findFirst({
    where: eq(standupSessions.id, sessionId),
    with: { config: true, participants: true },
  });
  if (!session || session.status !== 'collecting') return;

  const now = Date.now();
  const createdAt = new Date(session.createdAt).getTime();
  const delayMs = (session.config.reminderDelayMin ?? 30) * 60 * 1000;
  const intervalMs = (session.config.reminderIntervalMin ?? 60) * 60 * 1000;

  if (now <= createdAt + delayMs) return;

  if (session.lastRemindedAt) {
    const lastReminded = new Date(session.lastRemindedAt).getTime();
    if (now <= lastReminded + intervalMs) return;
  }

  const pending = session.participants.filter((p) => p.status === 'notified');
  if (pending.length === 0) return;

  const project = session.config.project;
  for (const participant of pending) {
    await createNotification(participant.userId, {
      type: 'system',
      title: 'Standup Reminder',
      body: `Reminder: Your standup update for ${project} is still pending.`,
      link: '/standup',
    });

    await sendTeamsNotification(participant.userId, {
      id: participant.id,
      userId: participant.userId,
      type: 'system',
      title: 'Standup Reminder',
      body: `Reminder: Your standup update for ${project} is still pending.`,
      link: '/standup',
      read: false,
      createdAt: new Date().toISOString(),
    }).catch((err) =>
      console.warn('[standup] Reminder Teams notification failed:', (err as Error).message),
    );
  }

  await db
    .update(standupSessions)
    .set({ lastRemindedAt: new Date().toISOString() })
    .where(eq(standupSessions.id, sessionId));

  console.log(`[standup] Sent reminders for session ${sessionId} to ${pending.length} participant(s)`);
}

// ── Session Generation ────────────────────────────────────────────────────────

export async function generateDailySessions(): Promise<number> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const currentDay = now.getDay(); // 0=Sun, 1=Mon...

  const configs = await db.query.standupConfigs.findMany({
    where: eq(standupConfigs.enabled, true),
    with: { group: true, skillSettings: standupSkillSettings },
  });

  let sessionsCreated = 0;

  for (const config of configs) {
    const weekdays = config.weekdays as number[];
    if (!weekdays.includes(currentDay)) continue;

    // Check if already generated for today
    const existing = await db.query.standupSessions.findFirst({
      where: and(
        eq(standupSessions.configId, config.id),
        eq(standupSessions.sessionDate, today),
      ),
    });
    if (existing) continue;

    // Check schedule time (simple HH:mm comparison in config timezone)
    const [schedHour, schedMin] = config.scheduleTime.split(':').map(Number);
    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
    const nowHour = nowInTz.getHours();
    const nowMin = nowInTz.getMinutes();
    if (nowHour < schedHour || (nowHour === schedHour && nowMin < schedMin)) continue;

    const resolvedGroupIds: string[] =
      Array.isArray(config.groupIds) && config.groupIds.length > 0
        ? (config.groupIds as string[])
        : config.groupId
        ? [config.groupId]
        : [];

    const members = await resolveStandupRoster({
      project: config.project,
      areaPath: config.areaPath,
      rosterMode: normalizeRosterMode(config.rosterMode),
      groupIds: resolvedGroupIds,
    });
    if (members.length === 0) continue;

    let standupSkillPath: string | undefined;
    let skillRepo = '';
    let skillBranch: string | undefined;
    const skillSettings = config.skillSettings as {
      skillRepo: string;
      skillBranch: string;
      workflowSettings: Array<{ skillPath: string | null }>;
    } | null;
    if (skillSettings) {
      standupSkillPath = skillSettings.workflowSettings[0]?.skillPath ?? undefined;
      skillRepo = skillSettings.skillRepo;
      skillBranch = skillSettings.skillBranch;
    }

    const deliveryModel = normalizeDeliveryModel(config.deliveryModel);
    const goalSource = normalizeGoalSource(config.goalSource);

    const sessionId = uuidv4();
    await db.insert(standupSessions).values({
      id: sessionId,
      configId: config.id,
      sessionDate: today,
      status: 'collecting',
    });

    for (const member of members) {
      const participantId = uuidv4();
      const kickoff: ChatThreadKickoff = {
        project: config.project,
        agentModule: 'standup',
        repo: skillRepo,
        branch: skillBranch,
        mode: 'standup-participant',
        standupSessionId: sessionId,
        standupParticipantId: participantId,
        standupSkillPath,
        standupUserDisplayName: member.displayName ?? undefined,
        standupUserEmail: member.email ?? undefined,
        standupDeliveryModel: deliveryModel,
        standupGoalSource: goalSource,
        standupTeamGoal: config.teamGoal ?? null,
        standupPolicy: config.policy ?? undefined,
        skillSettingsId: config.skillSettingsId,
      };

      const thread = await createThread(member.userId, kickoff);

      await db.insert(standupParticipants).values({
        id: participantId,
        sessionId,
        userId: member.userId,
        threadId: thread.id,
        status: 'notified',
      });

      await collectAndSaveParticipantBrief(participantId).catch((err) =>
        console.warn('[standup] Brief pre-computation failed:', (err as Error).message),
      );

      await createNotification(member.userId, {
        type: 'system',
        title: 'Daily Standup Ready',
        body: `Your standup for ${config.project} is ready. Click to begin.`,
        link: '/standup',
      });

      await sendTeamsNotification(member.userId, {
        id: participantId,
        userId: member.userId,
        type: 'system',
        title: 'Daily Standup Ready',
        body: `Your standup for ${config.project} is ready. Click to begin.`,
        link: '/standup',
        read: false,
        createdAt: new Date().toISOString(),
      }).catch((err) => console.warn('[standup] Teams notification failed:', (err as Error).message));
    }

    await recomputeSessionTeamPulse(sessionId).catch((err) =>
      console.warn('[standup] Initial team pulse synthesis skipped:', (err as Error).message),
    );

    sessionsCreated++;
    console.log(`[standup] Created session ${sessionId} for config ${config.id} with ${members.length} participants`);
  }

  return sessionsCreated;
}

// ── On-Demand Session Trigger ─────────────────────────────────────────────────

/**
 * Manually create a standup session for the given config, bypassing the
 * weekday / schedule-time check. If a session already exists for today it is
 * returned as-is so the caller can surface a friendly "already running" state.
 */
export async function triggerSessionForConfig(
  configId: string,
): Promise<{ sessionId: string; alreadyExisted: boolean }> {
  const config = await db.query.standupConfigs.findFirst({
    where: eq(standupConfigs.id, configId),
    with: { group: true, skillSettings: standupSkillSettings },
  });
  if (!config) throw new Error(`Standup config ${configId} not found`);

  const today = new Date().toISOString().slice(0, 10);

  const existing = await db.query.standupSessions.findFirst({
    where: and(
      eq(standupSessions.configId, configId),
      eq(standupSessions.sessionDate, today),
    ),
  });
  if (existing) return { sessionId: existing.id, alreadyExisted: true };

  const resolvedGroupIds: string[] =
    Array.isArray(config.groupIds) && config.groupIds.length > 0
      ? (config.groupIds as string[])
      : config.groupId
      ? [config.groupId]
      : [];

  const members = await resolveStandupRoster({
    project: config.project,
    areaPath: config.areaPath,
    rosterMode: normalizeRosterMode(config.rosterMode),
    groupIds: resolvedGroupIds,
  });
  if (members.length === 0) {
    throw new Error('No participants found via configured roster discovery or groups');
  }

  let standupSkillPath: string | undefined;
  let skillRepo = '';
  let skillBranch: string | undefined;
  const skillSettings = config.skillSettings as {
    skillRepo: string;
    skillBranch: string;
    workflowSettings: Array<{ skillPath: string | null }>;
  } | null;
  if (skillSettings) {
    standupSkillPath = skillSettings.workflowSettings[0]?.skillPath ?? undefined;
    skillRepo = skillSettings.skillRepo;
    skillBranch = skillSettings.skillBranch;
  }

  const deliveryModel = normalizeDeliveryModel(config.deliveryModel);
  const goalSource = normalizeGoalSource(config.goalSource);

  const sessionId = uuidv4();
  await db.insert(standupSessions).values({
    id: sessionId,
    configId: config.id,
    sessionDate: today,
    status: 'collecting',
  });

  for (const member of members) {
    const participantId = uuidv4();
    const kickoff: ChatThreadKickoff = {
      project: config.project,
      agentModule: 'standup',
      repo: skillRepo,
      branch: skillBranch,
      mode: 'standup-participant',
      standupSessionId: sessionId,
      standupParticipantId: participantId,
      standupSkillPath,
      standupUserDisplayName: member.displayName ?? undefined,
      standupUserEmail: member.email ?? undefined,
      standupDeliveryModel: deliveryModel,
      standupGoalSource: goalSource,
      standupTeamGoal: config.teamGoal ?? null,
      standupPolicy: config.policy ?? undefined,
      skillSettingsId: config.skillSettingsId,
    };

    const thread = await createThread(member.userId, kickoff);

    await db.insert(standupParticipants).values({
      id: participantId,
      sessionId,
      userId: member.userId,
      threadId: thread.id,
      status: 'notified',
    });

    await collectAndSaveParticipantBrief(participantId).catch((err) =>
      console.warn('[standup] Brief pre-computation failed:', (err as Error).message),
    );

    await createNotification(member.userId, {
      type: 'system',
      title: 'Daily Standup Ready',
      body: `Your standup for ${config.project} is ready. Click to begin.`,
      link: '/standup',
    });

    await sendTeamsNotification(member.userId, {
      id: participantId,
      userId: member.userId,
      type: 'system',
      title: 'Daily Standup Ready',
      body: `Your standup for ${config.project} is ready. Click to begin.`,
      link: '/standup',
      read: false,
      createdAt: new Date().toISOString(),
    }).catch((err) =>
      console.warn('[standup] Teams notification failed:', (err as Error).message),
    );
  }

  await recomputeSessionTeamPulse(sessionId).catch((err) =>
    console.warn('[standup] Initial team pulse synthesis skipped:', (err as Error).message),
  );

  console.log(`[standup] Manually triggered session ${sessionId} for config ${configId} with ${members.length} participants`);
  return { sessionId, alreadyExisted: false };
}

// ── Session Deletion ──────────────────────────────────────────────────────────

export async function deleteStandupSession(sessionId: string): Promise<void> {
  const session = await db.query.standupSessions.findFirst({
    where: eq(standupSessions.id, sessionId),
    with: { participants: true, followups: true },
  });
  if (!session) throw new Error('Session not found');

  const threadIds = new Set<string>();
  if (session.facilitatorThreadId) threadIds.add(session.facilitatorThreadId);
  for (const participant of session.participants) {
    if (participant.threadId) threadIds.add(participant.threadId);
  }
  for (const followup of session.followups) {
    if (followup.followupThreadId) threadIds.add(followup.followupThreadId);
  }

  await db.delete(standupSessions).where(eq(standupSessions.id, sessionId));

  for (const threadId of threadIds) {
    try {
      await deleteThread(threadId);
    } catch (err) {
      console.warn(`[standup] Failed to delete thread ${threadId}:`, (err as Error).message);
    }
  }

  console.log(`[standup] Deleted session ${sessionId} and ${threadIds.size} thread(s)`);
}

// ── Structured Update Extraction ──────────────────────────────────────────────

const VALID_APPROVAL_ACTIONS = new Set<StandupApprovalAction>([
  'approved',
  'approved_with_edits',
  'rejected_rewritten',
]);

function sanitizeStructuredUpdate(
  raw?: StandupStructuredUpdate | null,
): StandupStructuredUpdate | null {
  if (!raw || typeof raw !== 'object') return null;

  let itemDecisions: Record<string, StandupItemDecision> | undefined;
  if (raw.itemDecisions && typeof raw.itemDecisions === 'object') {
    const cleanDecisions: Record<string, StandupItemDecision> = {};
    for (const [k, v] of Object.entries(raw.itemDecisions)) {
      if (v === 'approved' || v === 'rejected') {
        cleanDecisions[k] = v;
      }
    }
    if (Object.keys(cleanDecisions).length > 0) {
      itemDecisions = cleanDecisions;
    }
  }

  let rejectedItems: StandupRejectedItemRecord[] | undefined;
  if (Array.isArray(raw.rejectedItems) && raw.rejectedItems.length > 0) {
    const cleanRejected = raw.rejectedItems
      .filter(
        (item): item is StandupRejectedItemRecord =>
          Boolean(item && typeof item.id === 'string' && typeof item.summary === 'string'),
      )
      .map((item) => ({
        id: item.id,
        summary: item.summary,
        ...(typeof item.reason === 'string' && item.reason.trim()
          ? { reason: item.reason.trim() }
          : {}),
      }));
    if (cleanRejected.length > 0) rejectedItems = cleanRejected;
  }

  const approvalAction =
    typeof raw.approvalAction === 'string' &&
    VALID_APPROVAL_ACTIONS.has(raw.approvalAction as StandupApprovalAction)
      ? (raw.approvalAction as StandupApprovalAction)
      : undefined;

  return {
    yesterday: typeof raw.yesterday === 'string' ? raw.yesterday : undefined,
    today: typeof raw.today === 'string' ? raw.today : undefined,
    blockers: typeof raw.blockers === 'string' ? raw.blockers : undefined,
    atRisk: typeof raw.atRisk === 'string' ? raw.atRisk : undefined,
    handoffs: typeof raw.handoffs === 'string' ? raw.handoffs : undefined,
    capacity: typeof raw.capacity === 'string' ? raw.capacity : undefined,
    ...(typeof raw.userCorrections === 'string' && raw.userCorrections.trim()
      ? { userCorrections: raw.userCorrections.trim() }
      : {}),
    ...(itemDecisions ? { itemDecisions } : {}),
    ...(rejectedItems ? { rejectedItems } : {}),
    ...(approvalAction ? { approvalAction } : {}),
  };
}

async function extractStructuredUpdate(
  threadId: string,
): Promise<StandupStructuredUpdate | null> {
  const messages = await db
    .select({ role: chatMessages.role, text: chatMessages.text })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.ts));

  for (const msg of messages) {
    if (msg.role !== 'agent') continue;

    const jsonBlockMatch = msg.text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (!jsonBlockMatch) continue;

    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        ('yesterday' in parsed || 'today' in parsed || 'blockers' in parsed)
      ) {
        return sanitizeStructuredUpdate(parsed);
      }
    } catch {
      // Malformed JSON in this block — try the next agent message
    }
  }

  return null;
}

// ── Participant Submission ─────────────────────────────────────────────────────

export interface SubmitParticipantOptions {
  structuredUpdate?: StandupStructuredUpdate | null;
  proposals?: StandupActionProposalInput[];
}

export async function submitParticipant(
  participantId: string,
  options?: SubmitParticipantOptions,
): Promise<void> {
  const participant = await db.query.standupParticipants.findFirst({
    where: eq(standupParticipants.id, participantId),
  });
  if (!participant) return;

  let structuredUpdate: StandupStructuredUpdate | null = null;
  if (options?.structuredUpdate) {
    structuredUpdate = sanitizeStructuredUpdate(options.structuredUpdate);
  } else if (participant.threadId) {
    structuredUpdate = await extractStructuredUpdate(participant.threadId);
    if (structuredUpdate) {
      console.log(`[standup] Extracted structured update for participant ${participantId}`);
    } else {
      console.warn(`[standup] No structured update found in thread ${participant.threadId} — participant submitted early or format mismatch`);
    }
  }

  const now = new Date().toISOString();
  await db
    .update(standupParticipants)
    .set({
      status: 'submitted',
      submittedAt: now,
      ...(structuredUpdate ? { structuredUpdate } : {}),
    })
    .where(eq(standupParticipants.id, participantId));

  if (options?.proposals && options.proposals.length > 0) {
    const sessionRow = await db.query.standupSessions.findFirst({
      where: eq(standupSessions.id, participant.sessionId),
      with: { config: true },
    });
    const project = sessionRow?.config?.project ?? '';
    await db.insert(standupActionProposals).values(
      options.proposals.map((proposal) => ({
        sessionId: participant.sessionId,
        participantId: participant.id,
        project,
        workItemId: proposal.workItemId,
        workItemTitle: proposal.workItemTitle,
        proposalType: proposal.proposalType,
        fieldName: proposal.fieldName,
        currentValue: proposal.currentValue ?? null,
        proposedValue: proposal.proposedValue,
        reason: proposal.reason,
        confidence: proposal.confidence ?? 'at_risk',
        status: 'pending' as const,
      })),
    );
  }

  await recomputeSessionTeamPulse(participant.sessionId).catch((err) =>
    console.warn('[standup] Team pulse recompute skipped:', (err as Error).message),
  );

  const allParticipants = await db
    .select({ status: standupParticipants.status })
    .from(standupParticipants)
    .where(eq(standupParticipants.sessionId, participant.sessionId));

  const allSubmitted = allParticipants.every((p) => p.status === 'submitted');
  if (allSubmitted) {
    console.log(`[standup] All participants submitted for session ${participant.sessionId}, triggering facilitator`);
    await runFacilitator(participant.sessionId);
  }
}

// ── Facilitator ───────────────────────────────────────────────────────────────

export async function runFacilitator(sessionId: string): Promise<void> {
  const session = await db.query.standupSessions.findFirst({
    where: eq(standupSessions.id, sessionId),
    with: { config: true },
  });
  if (!session) return;
  if (session.status === 'facilitating' || session.status === 'completed') return;

  await db
    .update(standupSessions)
    .set({ status: 'facilitating' })
    .where(eq(standupSessions.id, sessionId));

  const kickoff: ChatThreadKickoff = {
    project: session.config.project,
    agentModule: 'standup',
    repo: '',
    mode: 'standup-facilitator',
    standupSessionId: sessionId,
    standupDeliveryModel: normalizeDeliveryModel(session.config.deliveryModel),
    standupGoalSource: normalizeGoalSource(session.config.goalSource),
    standupTeamGoal: session.config.teamGoal ?? null,
    standupPolicy: session.config.policy ?? undefined,
    skillSettingsId: session.config.skillSettingsId,
  };

  const facilitatorThread = await createThread('system-standup-facilitator', kickoff);

  await db
    .update(standupSessions)
    .set({ facilitatorThreadId: facilitatorThread.id })
    .where(eq(standupSessions.id, sessionId));
}

/**
 * Mark session as completed, synthesize Team Pulse, and notify participants of follow-ups.
 */
export async function completeSession(
  sessionId: string,
  summaryMarkdown?: string,
  decisionsNeeded?: string[],
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(standupSessions)
    .set({
      status: 'completed',
      completedAt: now,
      summaryMarkdown: summaryMarkdown ?? null,
    })
    .where(eq(standupSessions.id, sessionId));

  await recomputeSessionTeamPulse(sessionId, decisionsNeeded).catch((err) =>
    console.warn('[standup] Team pulse synthesis on completion skipped:', (err as Error).message),
  );

  const session = await db.query.standupSessions.findFirst({
    where: eq(standupSessions.id, sessionId),
    with: { config: true },
  });
  const project = session?.config.project ?? '';

  const followups = await db
    .select()
    .from(standupFollowups)
    .where(eq(standupFollowups.sessionId, sessionId));

  for (const followup of followups) {
    const userIds = followup.participantUserIds as string[];

    let followupThreadId = followup.followupThreadId;
    if (!followupThreadId) {
      const owner = userIds[0] ?? 'system-standup-facilitator';
      const kickoff: ChatThreadKickoff = {
        project,
        agentModule: 'standup',
        repo: '',
        mode: 'standup-followup',
        standupSessionId: sessionId,
      };
      const thread = await createThread(owner, kickoff);
      followupThreadId = thread.id;
      await db
        .update(standupFollowups)
        .set({ followupThreadId, status: 'thread_created' })
        .where(eq(standupFollowups.id, followup.id));
    }

    for (const userId of userIds) {
      await createNotification(userId, {
        type: 'user-action',
        title: `Standup Follow-up: ${followup.title}`,
        body: followup.description ?? "A follow-up discussion has been created from today's standup.",
        link: `/standup-summary?session=${sessionId}`,
      });
    }
  }

  console.log(`[standup] Session ${sessionId} completed with ${followups.length} follow-ups`);
}
