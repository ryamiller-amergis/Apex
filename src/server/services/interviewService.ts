import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { interviews, prds } from '../db/schema';
import type {
  Interview,
  InterviewPhaseFlow,
  InterviewPhaseStatus,
  InterviewStatus,
  InterviewSummary,
  PhaseOwnerRole,
  PrdSummary,
} from '../../shared/types/interview';
import type { PrdStatus } from '../../shared/types/interview';
import type { EffortLevel } from '../../shared/types/effort';
import { cancelRun, markAsInterviewThread } from './chatAgentService';
import { createNotification } from './notificationService';
import { getSkillSettingsName } from './projectSettingsService';
import { runGroundingService } from './runGroundingService';
import { recordArtifactDoneEvent } from './artifactDoneEventService';
import { getActiveUsers } from './rbacService';

const VALID_INTERVIEW_STATUSES: InterviewStatus[] = ['in_progress', 'complete', 'archived'];
const VALID_PHASE_FLOWS: InterviewPhaseFlow[] = ['requirements_only', 'technical_only', 'both_sequential'];

function httpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as any).status = status;
  return err;
}

function phaseIsConfigured(flow: InterviewPhaseFlow, phase: PhaseOwnerRole): boolean {
  return flow === 'both_sequential'
    || (flow === 'requirements_only' && phase === 'requirements')
    || (flow === 'technical_only' && phase === 'technical');
}

async function assertActiveOwnerIds(
  project: string,
  owners: Array<{ id: string; label: 'Requirements' | 'Technical' }>,
): Promise<Map<string, string | null>> {
  if (owners.length === 0) return new Map();
  const activeUsers = await getActiveUsers(project);
  const activeUserNames = new Map(activeUsers.map((user) => [user.oid, user.displayName]));
  for (const owner of owners) {
    if (!activeUserNames.has(owner.id)) {
      throw httpError(400, `${owner.label} owner must be an active user in this project.`);
    }
  }
  return activeUserNames;
}

function assertValidInterviewStatus(status: string): asserts status is InterviewStatus {
  if (!VALID_INTERVIEW_STATUSES.includes(status as InterviewStatus)) {
    const err = new Error(`Invalid interview status: ${status}`);
    (err as any).status = 400;
    throw err;
  }
}

export async function createInterview(opts: {
  userId: string;
  project: string;
  repo: string;
  title?: string;
  chatThreadId: string;
  model?: string;
  effort?: EffortLevel;
  skillSettingsId?: string | null;
  prdOwnerId?: string;
  designDocOwnerId?: string;
  designPrototypeOwnerId?: string;
  testCaseOwnerId?: string;
  prdApproverIds?: string[];
  designDocApproverIds?: string[];
  designPrototypeApproverIds?: string[];
  testCaseApproverIds?: string[];
  prototypeStageEnabled?: boolean;
  testCasesEnabled?: boolean;
  phaseFlow?: InterviewPhaseFlow;
  requirementsOwnerId?: string;
  technicalOwnerId?: string;
}): Promise<{ interviewId: string; threadId: string }> {
  const prototypeStageEnabled = opts.prototypeStageEnabled !== false;
  const testCasesEnabled = opts.testCasesEnabled !== false;
  const phaseFlow = opts.phaseFlow ?? null;
  let requirementsOwnerId: string | null = null;
  let technicalOwnerId: string | null = null;
  let requirementsPhaseStatus: InterviewPhaseStatus | null = null;
  let technicalPhaseStatus: InterviewPhaseStatus | null = null;

  if (phaseFlow !== null) {
    if (!VALID_PHASE_FLOWS.includes(phaseFlow)) {
      throw httpError(400, `Invalid phase flow: ${phaseFlow}`);
    }
    if (phaseIsConfigured(phaseFlow, 'requirements') && !opts.requirementsOwnerId) {
      throw httpError(400, 'Requirements owner is required for the configured phase flow.');
    }
    if (phaseIsConfigured(phaseFlow, 'technical') && !opts.technicalOwnerId) {
      throw httpError(400, 'Technical owner is required for the configured phase flow.');
    }

    requirementsOwnerId = phaseIsConfigured(phaseFlow, 'requirements')
      ? opts.requirementsOwnerId!
      : null;
    technicalOwnerId = phaseIsConfigured(phaseFlow, 'technical')
      ? opts.technicalOwnerId!
      : null;
    await assertActiveOwnerIds(opts.project, [
      ...(requirementsOwnerId ? [{ id: requirementsOwnerId, label: 'Requirements' as const }] : []),
      ...(technicalOwnerId ? [{ id: technicalOwnerId, label: 'Technical' as const }] : []),
    ]);

    requirementsPhaseStatus = requirementsOwnerId ? 'draft' : null;
    technicalPhaseStatus = technicalOwnerId
      ? (phaseFlow === 'both_sequential' ? 'locked' : 'draft')
      : null;
  }

  const [row] = await db
    .insert(interviews)
    .values({
      chatThreadId: opts.chatThreadId,
      authorId: opts.userId,
      title: opts.title ?? 'Untitled Interview',
      project: opts.project,
      repo: opts.repo,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      skillSettingsId: opts.skillSettingsId ?? null,
      status: 'in_progress',
      prdOwnerId: opts.prdOwnerId ?? null,
      designDocOwnerId: opts.designDocOwnerId ?? null,
      designPrototypeOwnerId: prototypeStageEnabled ? (opts.designPrototypeOwnerId ?? null) : null,
      testCaseOwnerId: testCasesEnabled ? (opts.testCaseOwnerId ?? null) : null,
      phaseFlow,
      requirementsOwnerId,
      technicalOwnerId,
      requirementsPhaseStatus,
      technicalPhaseStatus,
      prdApproverIds: opts.prdApproverIds ?? null,
      designDocApproverIds: opts.designDocApproverIds ?? null,
      designPrototypeApproverIds: prototypeStageEnabled ? (opts.designPrototypeApproverIds ?? null) : null,
      testCaseApproverIds: testCasesEnabled ? (opts.testCaseApproverIds ?? null) : null,
      prototypeStageEnabled,
      testCasesEnabled,
    })
    .returning({ id: interviews.id });

  markAsInterviewThread(opts.chatThreadId);

  const interviewId = row.id;
  const interviewTitle = opts.title ?? 'Untitled Interview';

  try {
    const notificationPromises: Promise<void>[] = [];

    if (opts.prdOwnerId) {
      notificationPromises.push(
        createNotification(opts.prdOwnerId, {
          type: 'user-action',
          title: 'Assigned as PRD Owner',
          body: `You were assigned as PRD owner for the interview "${interviewTitle}".`,
          link: `/backlog/interview/${interviewId}`,
        }).then(() => undefined),
      );
    }

    if (opts.designDocOwnerId) {
      notificationPromises.push(
        createNotification(opts.designDocOwnerId, {
          type: 'user-action',
          title: 'Assigned as Design Doc Owner',
          body: `You were assigned as Design Doc owner for the interview "${interviewTitle}".`,
          link: `/backlog/interview/${interviewId}`,
        }).then(() => undefined),
      );
    }

    if (prototypeStageEnabled && opts.designPrototypeOwnerId) {
      notificationPromises.push(
        createNotification(opts.designPrototypeOwnerId, {
          type: 'user-action',
          title: 'Assigned as Design Prototype Owner',
          body: `You were assigned as Design Prototype owner for the interview "${interviewTitle}".`,
          link: `/backlog/interview/${interviewId}`,
        }).then(() => undefined),
      );
    }

    if (testCasesEnabled && opts.testCaseOwnerId) {
      notificationPromises.push(
        createNotification(opts.testCaseOwnerId, {
          type: 'user-action',
          title: 'Assigned as Test Case Owner',
          body: `You were assigned as Test Case owner for the interview "${interviewTitle}".`,
          link: `/backlog/interview/${interviewId}`,
        }).then(() => undefined),
      );
    }

    if (requirementsOwnerId) {
      notificationPromises.push(
        createNotification(requirementsOwnerId, {
          type: 'user-action',
          title: 'Assigned as Requirements Owner',
          body: `You were assigned as Requirements owner for the interview "${interviewTitle}".`,
          link: `/backlog/interview/${interviewId}`,
        }).then(() => undefined),
      );
    }

    if (technicalOwnerId) {
      notificationPromises.push(
        createNotification(technicalOwnerId, {
          type: 'user-action',
          title: 'Assigned as Technical Owner',
          body: `You were assigned as Technical owner for the interview "${interviewTitle}".`,
          link: `/backlog/interview/${interviewId}`,
        }).then(() => undefined),
      );
    }

    const interviewLink = `/backlog/interview/${interviewId}`;
    const reviewerAssignments: Array<{ userIds: string[] | undefined; title: string; role: string }> = [
      { userIds: opts.prdApproverIds, title: 'Assigned as PRD Reviewer', role: 'PRD reviewer' },
      { userIds: opts.designDocApproverIds, title: 'Assigned as Design Doc Reviewer', role: 'Design Doc reviewer' },
    ];
    if (prototypeStageEnabled) {
      reviewerAssignments.push({
        userIds: opts.designPrototypeApproverIds,
        title: 'Assigned as Design Prototype Reviewer',
        role: 'Design Prototype reviewer',
      });
    }
    if (testCasesEnabled) {
      reviewerAssignments.push({
        userIds: opts.testCaseApproverIds,
        title: 'Assigned as QA Reviewer',
        role: 'QA reviewer',
      });
    }
    for (const { userIds, title, role } of reviewerAssignments) {
      for (const userId of userIds ?? []) {
        notificationPromises.push(
          createNotification(userId, {
            type: 'user-action',
            title,
            body: `You were assigned as ${role} for the interview "${interviewTitle}".`,
            link: interviewLink,
          }).then(() => undefined),
        );
      }
    }

    if (notificationPromises.length > 0) {
      const results = await Promise.allSettled(notificationPromises);
      for (const result of results) {
        if (result.status === 'rejected') {
          console.error('[interviewService] Section-owner notification failed:', result.reason);
        }
      }
    }
  } catch (err) {
    console.error('[interviewService] Notification dispatch error:', err);
  }

  return { interviewId, threadId: opts.chatThreadId };
}

export async function listInterviews(
  filters?: { status?: InterviewStatus; project?: string; authorId?: string },
): Promise<InterviewSummary[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.authorId) {
    conditions.push(eq(interviews.authorId, filters.authorId));
  }
  if (filters?.status) {
    conditions.push(eq(interviews.status, filters.status));
  }
  if (filters?.project) {
    conditions.push(eq(interviews.project, filters.project));
  }

  const rows = await db
    .select({
      id: interviews.id,
      chatThreadId: interviews.chatThreadId,
      authorId: interviews.authorId,
      title: interviews.title,
      project: interviews.project,
      repo: interviews.repo,
      model: interviews.model,
      effort: interviews.effort,
      status: interviews.status,
      prdOwnerId: interviews.prdOwnerId,
      designDocOwnerId: interviews.designDocOwnerId,
      designPrototypeOwnerId: interviews.designPrototypeOwnerId,
      testCaseOwnerId: interviews.testCaseOwnerId,
      phaseFlow: interviews.phaseFlow,
      requirementsOwnerId: interviews.requirementsOwnerId,
      technicalOwnerId: interviews.technicalOwnerId,
      requirementsPhaseStatus: interviews.requirementsPhaseStatus,
      technicalPhaseStatus: interviews.technicalPhaseStatus,
      technicalPhaseChatThreadId: interviews.technicalPhaseChatThreadId,
      skillSettingsId: interviews.skillSettingsId,
      prdApproverIds: interviews.prdApproverIds,
      designDocApproverIds: interviews.designDocApproverIds,
      designPrototypeApproverIds: interviews.designPrototypeApproverIds,
      testCaseApproverIds: interviews.testCaseApproverIds,
      prototypeStageEnabled: interviews.prototypeStageEnabled,
      createdAt: interviews.createdAt,
      updatedAt: interviews.updatedAt,
    })
    .from(interviews)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(interviews.updatedAt));

  const prdCounts = await db
    .select({ interviewId: prds.interviewId, cnt: count() })
    .from(prds)
    .groupBy(prds.interviewId);

  const prdCountMap = new Map(prdCounts.map((r) => [r.interviewId, Number(r.cnt)]));

  const uniqueSettingsIds = [...new Set(rows.map((r) => r.skillSettingsId).filter(Boolean))] as string[];
  const settingsNameEntries = await Promise.all(uniqueSettingsIds.map(async (id) => [id, await getSkillSettingsName(id)] as const));
  const settingsNameMap = new Map(settingsNameEntries);

  return rows.map((row) => ({
    id: row.id,
    chatThreadId: row.chatThreadId,
    authorId: row.authorId,
    title: row.title,
    project: row.project,
    repo: row.repo,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    status: row.status as InterviewStatus,
    prdCount: prdCountMap.get(row.id) ?? 0,
    prdOwnerId: row.prdOwnerId ?? undefined,
    designDocOwnerId: row.designDocOwnerId ?? undefined,
    designPrototypeOwnerId: row.designPrototypeOwnerId ?? undefined,
    testCaseOwnerId: row.testCaseOwnerId ?? undefined,
    phaseFlow: row.phaseFlow as InterviewPhaseFlow | null,
    requirementsOwnerId: row.requirementsOwnerId ?? null,
    technicalOwnerId: row.technicalOwnerId ?? null,
    requirementsPhaseStatus: row.requirementsPhaseStatus as InterviewPhaseStatus | null,
    technicalPhaseStatus: row.technicalPhaseStatus as InterviewPhaseStatus | null,
    technicalPhaseChatThreadId: row.technicalPhaseChatThreadId ?? null,
    skillSettingsId: row.skillSettingsId ?? null,
    skillSettingsName: row.skillSettingsId ? settingsNameMap.get(row.skillSettingsId) ?? null : null,
    prdApproverIds: row.prdApproverIds ?? undefined,
    designDocApproverIds: row.designDocApproverIds ?? undefined,
    designPrototypeApproverIds: row.designPrototypeApproverIds ?? undefined,
    testCaseApproverIds: row.testCaseApproverIds ?? undefined,
    prototypeStageEnabled: row.prototypeStageEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getInterview(id: string): Promise<Interview | null> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, id),
    with: {
      prds: true,
      prdOwner: true,
      designDocOwner: true,
      designPrototypeOwner: true,
      testCaseOwner: true,
      requirementsOwner: true,
      technicalOwner: true,
    },
  });

  if (!row) return null;

  const skillSettingsName = await getSkillSettingsName(row.skillSettingsId);

  const prdSummaries: PrdSummary[] = row.prds.map((p) => ({
    id: p.id,
    interviewId: p.interviewId,
    chatThreadId: p.chatThreadId ?? '',
    authorId: p.authorId,
    project: p.project,
    title: p.title,
    model: p.model ?? undefined,
    effort: p.effort ?? undefined,
    status: p.status as PrdStatus,
    reviewerId: p.reviewerId ?? undefined,
    reviewComment: p.reviewComment ?? undefined,
    reviewedAt: p.reviewedAt ?? undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));

  return {
    id: row.id,
    chatThreadId: row.chatThreadId,
    authorId: row.authorId,
    title: row.title,
    project: row.project,
    repo: row.repo,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    status: row.status as InterviewStatus,
    prdCount: row.prds.length,
    prdOwnerId: row.prdOwnerId ?? undefined,
    prdOwnerName: row.prdOwner?.displayName ?? undefined,
    designDocOwnerId: row.designDocOwnerId ?? undefined,
    designDocOwnerName: row.designDocOwner?.displayName ?? undefined,
    designPrototypeOwnerId: row.designPrototypeOwnerId ?? undefined,
    designPrototypeOwnerName: row.designPrototypeOwner?.displayName ?? undefined,
    testCaseOwnerId: row.testCaseOwnerId ?? undefined,
    testCaseOwnerName: row.testCaseOwner?.displayName ?? undefined,
    phaseFlow: row.phaseFlow as InterviewPhaseFlow | null,
    requirementsOwnerId: row.requirementsOwnerId ?? null,
    requirementsOwnerName: row.requirementsOwner?.displayName ?? undefined,
    technicalOwnerId: row.technicalOwnerId ?? null,
    technicalOwnerName: row.technicalOwner?.displayName ?? undefined,
    requirementsPhaseStatus: row.requirementsPhaseStatus as InterviewPhaseStatus | null,
    technicalPhaseStatus: row.technicalPhaseStatus as InterviewPhaseStatus | null,
    technicalPhaseChatThreadId: row.technicalPhaseChatThreadId ?? null,
    skillSettingsId: row.skillSettingsId ?? null,
    skillSettingsName,
    prdApproverIds: row.prdApproverIds ?? undefined,
    designDocApproverIds: row.designDocApproverIds ?? undefined,
    designPrototypeApproverIds: row.designPrototypeApproverIds ?? undefined,
    testCaseApproverIds: row.testCaseApproverIds ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    prds: prdSummaries,
  };
}

export async function reassignPhaseOwner(
  interviewId: string,
  phase: PhaseOwnerRole,
  newOwnerId: string,
  requestingUserId: string,
  requestingUserPerms: Set<string>,
): Promise<{ phase: PhaseOwnerRole; ownerId: string; ownerName: string | null }> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
  });
  if (!row) {
    throw httpError(404, 'Interview not found');
  }
  if (row.authorId !== requestingUserId && !requestingUserPerms.has('admin:roles')) {
    throw httpError(403, 'Only the interview creator or an admin can change phase owners.');
  }

  const phaseFlow = row.phaseFlow as InterviewPhaseFlow | null;
  if (!phaseFlow || !phaseIsConfigured(phaseFlow, phase)) {
    throw httpError(400, `The ${phase} phase is not configured for this interview.`);
  }

  const phaseStatus = phase === 'requirements'
    ? row.requirementsPhaseStatus
    : row.technicalPhaseStatus;
  if (phaseStatus === 'approved') {
    throw httpError(409, 'This phase has already been approved and its owner cannot be changed.');
  }

  const label = phase === 'requirements' ? 'Requirements' : 'Technical';
  const activeUserNames = await assertActiveOwnerIds(row.project, [{ id: newOwnerId, label }]);
  const updatedAt = new Date().toISOString();
  const ownerUpdate = phase === 'requirements'
    ? { requirementsOwnerId: newOwnerId, updatedAt }
    : { technicalOwnerId: newOwnerId, updatedAt };

  await db.update(interviews).set(ownerUpdate).where(eq(interviews.id, interviewId));

  try {
    await createNotification(newOwnerId, {
      type: 'user-action',
      title: `Assigned as ${label} Owner`,
      body: `You were assigned as ${label.toLowerCase()} owner for the interview "${row.title}".`,
      link: `/backlog/interview/${interviewId}`,
    });
  } catch (err) {
    console.error('[interviewService] Phase-owner notification failed:', err);
  }

  return {
    phase,
    ownerId: newOwnerId,
    ownerName: activeUserNames.get(newOwnerId) ?? null,
  };
}

export async function updateInterviewStatus(
  id: string,
  requestingUserId: string,
  newStatus: InterviewStatus,
): Promise<void> {
  assertValidInterviewStatus(newStatus);

  const row = await db.query.interviews.findFirst({ where: eq(interviews.id, id) });
  if (!row) {
    const err = new Error('Interview not found');
    (err as any).status = 404;
    throw err;
  }
  if (row.authorId !== requestingUserId) {
    const err = new Error('Only the author can change interview status');
    (err as any).status = 403;
    throw err;
  }

  const transitionAt = new Date().toISOString();
  const persistStatus = () =>
    db
      .update(interviews)
      .set({ status: newStatus, updatedAt: transitionAt })
      .where(eq(interviews.id, id));

  if (newStatus === 'complete' || newStatus === 'archived') {
    await runGroundingService.persistThenMarkTerminalInactive(
      {
        runType: 'chat',
        runId: row.chatThreadId,
        project: row.project,
      },
      persistStatus,
    );
    if (newStatus === 'complete') {
      try {
        await recordArtifactDoneEvent('interview', id, transitionAt);
      } catch (err) {
        console.error(`[interview] Failed to record done event (interviewId=${id})`, err);
      }
    }
    return;
  }

  await persistStatus();
}

export async function updateInterviewTitle(
  id: string,
  requestingUserId: string,
  title: string,
): Promise<void> {
  const row = await db.query.interviews.findFirst({ where: eq(interviews.id, id) });
  if (!row) {
    const err = new Error('Interview not found');
    (err as any).status = 404;
    throw err;
  }
  if (row.authorId !== requestingUserId) {
    const err = new Error('Only the author can rename the interview');
    (err as any).status = 403;
    throw err;
  }

  await db
    .update(interviews)
    .set({ title, updatedAt: new Date().toISOString() })
    .where(eq(interviews.id, id));
}

export async function deleteInterview(id: string, requestingUserId: string): Promise<void> {
  const row = await db.query.interviews.findFirst({ where: eq(interviews.id, id) });
  if (!row) {
    const err = new Error('Interview not found');
    (err as any).status = 404;
    throw err;
  }
  if (row.authorId !== requestingUserId) {
    const err = new Error('Only the author can delete the interview');
    (err as any).status = 403;
    throw err;
  }
  await cancelRun(row.chatThreadId);
  await db.delete(interviews).where(eq(interviews.id, id));
}
