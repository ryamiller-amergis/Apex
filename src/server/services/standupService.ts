import { eq, and, desc, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/drizzle';
import {
  standupConfigs,
  standupSessions,
  standupParticipants,
  standupFollowups,
  appGroupMembers,
  appUsers,
  projectSkillSettings,
  chatMessages,
} from '../db/schema';
import { createThread } from './chatAgentService';
import { deleteThread } from './chatThreadRepository';
import { createNotification } from './notificationService';
import { sendTeamsNotification } from './teamsBotService';
import type { ChatThreadKickoff } from '../../shared/types/chat';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch unique members across one or more groups, deduped by userId. */
async function getMembersForGroups(
  groupIds: string[],
): Promise<Array<{ userId: string; displayName: string | null; email: string | null }>> {
  if (groupIds.length === 0) return [];
  const rows = await db
    .select({
      userId: appGroupMembers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(appGroupMembers)
    .innerJoin(appUsers, eq(appGroupMembers.userId, appUsers.oid))
    .where(inArray(appGroupMembers.groupId, groupIds));

  // Dedupe — a user may belong to multiple selected groups
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.userId)) return false;
    seen.add(r.userId);
    return true;
  });
}

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
    with: { group: true, skillSettings: true },
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

    // Resolve which group IDs to use (prefer new groupIds array, fall back to legacy groupId)
    const resolvedGroupIds: string[] =
      Array.isArray(config.groupIds) && config.groupIds.length > 0
        ? (config.groupIds as string[])
        : config.groupId
        ? [config.groupId]
        : [];

    const members = await getMembersForGroups(resolvedGroupIds);
    if (members.length === 0) continue;

    // Resolve skill path + repo/branch from the project skill settings (if any).
    // repo/branch are needed so the participant agent can get_skill a custom standup skill.
    let standupSkillPath: string | undefined;
    let skillRepo = '';
    let skillBranch: string | undefined;
    if (config.skillSettings) {
      const settings = config.skillSettings as typeof projectSkillSettings.$inferSelect;
      standupSkillPath = settings.standupSkillPath ?? undefined;
      skillRepo = settings.skillRepo;
      skillBranch = settings.skillBranch;
    }

    // Create session
    const sessionId = uuidv4();
    await db.insert(standupSessions).values({
      id: sessionId,
      configId: config.id,
      sessionDate: today,
      status: 'collecting',
    });

    // Create participant rows + threads
    for (const member of members) {
      const participantId = uuidv4();
      const kickoff: ChatThreadKickoff = {
        project: config.project,
        repo: skillRepo,
        branch: skillBranch,
        mode: 'standup-participant',
        standupSessionId: sessionId,
        standupParticipantId: participantId,
        standupSkillPath,
        standupUserDisplayName: member.displayName ?? undefined,
        standupUserEmail: member.email ?? undefined,
        skillSettingsId: config.skillSettingsId,
      };

      // createThread auto-sends a hidden "Begin." kickoff, so the agent greets
      // the member with the standup questions as soon as they open the thread.
      const thread = await createThread(member.userId, kickoff);

      await db.insert(standupParticipants).values({
        id: participantId,
        sessionId,
        userId: member.userId,
        threadId: thread.id,
        status: 'notified',
      });

      // Send in-app notification
      await createNotification(member.userId, {
        type: 'system',
        title: 'Daily Standup Ready',
        body: `Your standup for ${config.project} is ready. Click to begin.`,
        link: '/standup',
      });

      // Send Teams notification
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
    with: { group: true, skillSettings: true },
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

  const members = await getMembersForGroups(resolvedGroupIds);
  if (members.length === 0) throw new Error('No members in the configured standup groups');

  let standupSkillPath: string | undefined;
  let skillRepo = '';
  let skillBranch: string | undefined;
  if (config.skillSettings) {
    const settings = config.skillSettings as typeof projectSkillSettings.$inferSelect;
    standupSkillPath = settings.standupSkillPath ?? undefined;
    skillRepo = settings.skillRepo;
    skillBranch = settings.skillBranch;
  }

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
      repo: skillRepo,
      branch: skillBranch,
      mode: 'standup-participant',
      standupSessionId: sessionId,
      standupParticipantId: participantId,
      standupSkillPath,
      standupUserDisplayName: member.displayName ?? undefined,
      standupUserEmail: member.email ?? undefined,
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

  console.log(`[standup] Manually triggered session ${sessionId} for config ${configId} with ${members.length} participants`);
  return { sessionId, alreadyExisted: false };
}

// ── Session Deletion ──────────────────────────────────────────────────────────

/**
 * Delete a standup session and all associated chat threads (participant,
 * facilitator, and follow-up). Lets admins clear today's session so a fresh
 * one can be triggered via Run Now.
 */
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

type StructuredUpdate = {
  yesterday?: string;
  today?: string;
  blockers?: string;
  atRisk?: string;
  handoffs?: string;
  capacity?: string;
};

/**
 * Scans agent messages in a thread from newest to oldest and extracts the first
 * JSON code block that looks like { yesterday, today, blockers, atRisk, handoffs,
 * capacity }. The participant prompt instructs the agent to emit exactly this
 * structure at the end of the standup. Returns null if none is found (e.g. the
 * user submitted early).
 */
async function extractStructuredUpdate(
  threadId: string,
): Promise<StructuredUpdate | null> {
  const messages = await db
    .select({ role: chatMessages.role, text: chatMessages.text })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.ts));

  for (const msg of messages) {
    if (msg.role !== 'agent') continue;

    // Match ```json ... ``` blocks (including ``` json with a space)
    const jsonBlockMatch = msg.text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (!jsonBlockMatch) continue;

    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        ('yesterday' in parsed || 'today' in parsed || 'blockers' in parsed)
      ) {
        return {
          yesterday: typeof parsed.yesterday === 'string' ? parsed.yesterday : undefined,
          today: typeof parsed.today === 'string' ? parsed.today : undefined,
          blockers: typeof parsed.blockers === 'string' ? parsed.blockers : undefined,
          atRisk: typeof parsed.atRisk === 'string' ? parsed.atRisk : undefined,
          handoffs: typeof parsed.handoffs === 'string' ? parsed.handoffs : undefined,
          capacity: typeof parsed.capacity === 'string' ? parsed.capacity : undefined,
        };
      }
    } catch {
      // Malformed JSON in this block — try the next agent message
    }
  }

  return null;
}

// ── Participant Submission ─────────────────────────────────────────────────────

export async function submitParticipant(participantId: string): Promise<void> {
  // Load the participant first to get their threadId for parsing
  const participant = await db.query.standupParticipants.findFirst({
    where: eq(standupParticipants.id, participantId),
  });
  if (!participant) return;

  // Parse the structured update from the agent conversation transcript
  let structuredUpdate: StructuredUpdate | null = null;
  if (participant.threadId) {
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
    repo: '',
    mode: 'standup-facilitator',
    standupSessionId: sessionId,
    skillSettingsId: session.config.skillSettingsId,
  };

  // Use a system user ID for the facilitator thread. createThread auto-sends a
  // hidden "Begin." kickoff, so the facilitator agent starts analyzing the
  // session immediately: it reads all updates via get_standup_session, records
  // cross-cutting follow-ups via create_standup_followup, and finally calls
  // complete_standup_session, which transitions the session to completed,
  // persists the summary, spins up joint follow-up threads, and notifies members.
  const facilitatorThread = await createThread('system-standup-facilitator', kickoff);

  await db
    .update(standupSessions)
    .set({ facilitatorThreadId: facilitatorThread.id })
    .where(eq(standupSessions.id, sessionId));
}

/**
 * Mark session as completed and notify participants of follow-ups.
 */
export async function completeSession(sessionId: string, summaryMarkdown?: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(standupSessions)
    .set({ status: 'completed', completedAt: now, summaryMarkdown: summaryMarkdown ?? null })
    .where(eq(standupSessions.id, sessionId));

  // Resolve the session's project so follow-up threads carry the right context.
  const session = await db.query.standupSessions.findFirst({
    where: eq(standupSessions.id, sessionId),
    with: { config: true },
  });
  const project = session?.config.project ?? '';

  // For each follow-up, spin up a joint discussion thread and notify the
  // involved members so the right people can continue the conversation.
  const followups = await db
    .select()
    .from(standupFollowups)
    .where(eq(standupFollowups.sessionId, sessionId));

  for (const followup of followups) {
    const userIds = followup.participantUserIds as string[];

    // Create a joint follow-up thread (owned by the first involved member, or
    // the system user if none) unless one already exists.
    let followupThreadId = followup.followupThreadId;
    if (!followupThreadId) {
      const owner = userIds[0] ?? 'system-standup-facilitator';
      const kickoff: ChatThreadKickoff = {
        project,
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
