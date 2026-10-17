import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { interviews, prds } from '../db/schema';
import type { Interview, InterviewStatus, InterviewSummary, PrdSummary } from '../../shared/types/interview';
import type { PrdStatus } from '../../shared/types/interview';
import type { EffortLevel } from '../../shared/types/effort';
import type { InterviewProfileSnapshot, InterviewStepMode } from '../../shared/types/playbook';
import { cancelRun, markAsInterviewThread } from './chatAgentService';
import { createNotification } from './notificationService';
import { isPlatformAdmin, isProjectAdmin } from '../utils/rbacHelpers';
import { getActiveUsers } from './rbacService';
import { getSkillSettingsName } from './projectSettingsService';
import { runGroundingService } from './runGroundingService';
import { recordArtifactDoneEvent } from './artifactDoneEventService';
import { listLinkedContextIds } from './interviewLinkService';
import {
  latestGuidedInterviewPhaseIndex,
  sliceGuidedInterviewPhases,
  usesGuidedInterview,
} from './guidedInterviewState';

const VALID_INTERVIEW_STATUSES: InterviewStatus[] = ['in_progress', 'complete', 'archived'];

function assertValidInterviewStatus(status: string): asserts status is InterviewStatus {
  if (!VALID_INTERVIEW_STATUSES.includes(status as InterviewStatus)) {
    const err = new Error(`Invalid interview status: ${status}`);
    (err as any).status = 400;
    throw err;
  }
}

const PLAYBOOK_LINKAGE_ERROR =
  'Playbook interview linkage requires a run, step run, mode, profile key, and snapshot.';

function playbookInterviewColumns(opts: {
  playbookRunId?: string | null;
  playbookStepRunId?: string | null;
  playbookInterviewMode?: InterviewStepMode | null;
  playbookProfileKey?: string | null;
  playbookProfileSnapshot?: InterviewProfileSnapshot | null;
}): {
  playbookRunId: string | null;
  playbookStepRunId: string | null;
  playbookInterviewMode: InterviewStepMode | null;
  playbookProfileKey: string | null;
  playbookProfileSnapshot: InterviewProfileSnapshot | null;
} {
  const provided = [
    opts.playbookRunId,
    opts.playbookStepRunId,
    opts.playbookInterviewMode,
    opts.playbookProfileKey,
    opts.playbookProfileSnapshot,
  ];
  const anySet = provided.some((value) => value != null);
  const allSet = provided.every((value) => value != null);
  if (!anySet) {
    return {
      playbookRunId: null,
      playbookStepRunId: null,
      playbookInterviewMode: null,
      playbookProfileKey: null,
      playbookProfileSnapshot: null,
    };
  }
  if (!allSet) {
    throw new Error(PLAYBOOK_LINKAGE_ERROR);
  }

  const mode = opts.playbookInterviewMode;
  const profileKey = opts.playbookProfileKey?.trim() ?? '';
  const snapshot = opts.playbookProfileSnapshot;
  if (
    (mode !== 'human_led' && mode !== 'multi_agent_assisted') ||
    profileKey.length === 0 ||
    !snapshot ||
    snapshot.mode !== mode ||
    snapshot.key !== profileKey
  ) {
    throw new Error(PLAYBOOK_LINKAGE_ERROR);
  }

  return {
    playbookRunId: opts.playbookRunId ?? null,
    playbookStepRunId: opts.playbookStepRunId ?? null,
    playbookInterviewMode: mode,
    playbookProfileKey: profileKey,
    playbookProfileSnapshot: snapshot,
  };
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
  playbookRunId?: string | null;
  playbookStepRunId?: string | null;
  playbookInterviewMode?: InterviewStepMode | null;
  playbookProfileKey?: string | null;
  playbookProfileSnapshot?: InterviewProfileSnapshot | null;
}): Promise<{ interviewId: string; threadId: string }> {
  const prototypeStageEnabled = opts.prototypeStageEnabled !== false;
  const testCasesEnabled = opts.testCasesEnabled !== false;
  const playbook = playbookInterviewColumns(opts);

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
      prdApproverIds: opts.prdApproverIds ?? null,
      designDocApproverIds: opts.designDocApproverIds ?? null,
      designPrototypeApproverIds: prototypeStageEnabled ? (opts.designPrototypeApproverIds ?? null) : null,
      testCaseApproverIds: testCasesEnabled ? (opts.testCaseApproverIds ?? null) : null,
      prototypeStageEnabled,
      testCasesEnabled,
      playbookRunId: playbook.playbookRunId,
      playbookStepRunId: playbook.playbookStepRunId,
      playbookInterviewMode: playbook.playbookInterviewMode,
      playbookProfileKey: playbook.playbookProfileKey,
      playbookProfileSnapshot: playbook.playbookProfileSnapshot,
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
      discoveryAssigneeId: interviews.discoveryAssigneeId,
      deliveryAssigneeId: interviews.deliveryAssigneeId,
      technicalAssigneeId: interviews.technicalAssigneeId,
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
    discoveryAssigneeId: row.discoveryAssigneeId ?? undefined,
    deliveryAssigneeId: row.deliveryAssigneeId ?? undefined,
    technicalAssigneeId: row.technicalAssigneeId ?? undefined,
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
      discoveryAssignee: true,
      deliveryAssignee: true,
      technicalAssignee: true,
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
    discoveryAssigneeId: row.discoveryAssigneeId ?? undefined,
    discoveryAssigneeName: row.discoveryAssignee?.displayName ?? undefined,
    deliveryAssigneeId: row.deliveryAssigneeId ?? undefined,
    deliveryAssigneeName: row.deliveryAssignee?.displayName ?? undefined,
    technicalAssigneeId: row.technicalAssigneeId ?? undefined,
    technicalAssigneeName: row.technicalAssignee?.displayName ?? undefined,
    skillSettingsId: row.skillSettingsId ?? null,
    skillSettingsName,
    prdApproverIds: row.prdApproverIds ?? undefined,
    designDocApproverIds: row.designDocApproverIds ?? undefined,
    designPrototypeApproverIds: row.designPrototypeApproverIds ?? undefined,
    testCaseApproverIds: row.testCaseApproverIds ?? undefined,
    prototypeStageEnabled: row.prototypeStageEnabled,
    testCasesEnabled: row.testCasesEnabled,
    playbookRunId: row.playbookRunId,
    playbookStepRunId: row.playbookStepRunId,
    playbookInterviewMode: row.playbookInterviewMode,
    playbookProfileKey: row.playbookProfileKey,
    playbookProfileSnapshot: row.playbookProfileSnapshot,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    prds: prdSummaries,
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

export interface InterviewPhaseAssignments {
  discoveryAssigneeId?: string | null;
  deliveryAssigneeId?: string | null;
  technicalAssigneeId?: string | null;
}

function assigneeOrNull(id: string | null | undefined): string | null {
  const trimmed = id?.trim();
  return trimmed ? trimmed : null;
}

function hasAssignment(
  assignments: InterviewPhaseAssignments,
  key: keyof InterviewPhaseAssignments,
): boolean {
  return Object.prototype.hasOwnProperty.call(assignments, key);
}

/**
 * The interview author, a project admin, or a platform admin can assign
 * Discovery, Delivery, and Technical to project users.
 */
export async function updateInterviewPhaseAssignments(
  id: string,
  requestingUserId: string,
  assignments: InterviewPhaseAssignments,
): Promise<void> {
  const row = await db.query.interviews.findFirst({ where: eq(interviews.id, id) });
  if (!row) {
    const err = new Error('Interview not found');
    (err as any).status = 404;
    throw err;
  }

  const allowed = row.authorId === requestingUserId
    || await isPlatformAdmin(requestingUserId)
    || await isProjectAdmin(requestingUserId, row.project);
  if (!allowed) {
    const err = new Error('Only the interview owner, a project admin, or a platform admin can assign phases');
    (err as any).status = 403;
    throw err;
  }

  const next = {
    discoveryAssigneeId: hasAssignment(assignments, 'discoveryAssigneeId')
      ? assigneeOrNull(assignments.discoveryAssigneeId)
      : row.discoveryAssigneeId,
    deliveryAssigneeId: hasAssignment(assignments, 'deliveryAssigneeId')
      ? assigneeOrNull(assignments.deliveryAssigneeId)
      : row.deliveryAssigneeId,
    technicalAssigneeId: hasAssignment(assignments, 'technicalAssigneeId')
      ? assigneeOrNull(assignments.technicalAssigneeId)
      : row.technicalAssigneeId,
  };
  const activeUserIds = new Set((await getActiveUsers(row.project)).map((user) => user.oid));
  const assignmentKeys: Array<keyof InterviewPhaseAssignments> = [
    'discoveryAssigneeId',
    'deliveryAssigneeId',
    'technicalAssigneeId',
  ];
  const invalidAssignee = assignmentKeys
    .filter((key) => hasAssignment(assignments, key))
    .map((key) => next[key])
    .find((assigneeId) => assigneeId && !activeUserIds.has(assigneeId));
  if (invalidAssignee) {
    const err = new Error('Phase assignees must be active users in this project');
    (err as any).status = 400;
    throw err;
  }

  const updates: Partial<typeof next> & { updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (hasAssignment(assignments, 'discoveryAssigneeId')) {
    updates.discoveryAssigneeId = next.discoveryAssigneeId;
  }
  if (hasAssignment(assignments, 'deliveryAssigneeId')) {
    updates.deliveryAssigneeId = next.deliveryAssigneeId;
  }
  if (hasAssignment(assignments, 'technicalAssigneeId')) {
    updates.technicalAssigneeId = next.technicalAssigneeId;
  }

  await db
    .update(interviews)
    .set(updates)
    .where(eq(interviews.id, id));

  const interviewTitle = row.title ?? 'Untitled Interview';
  const changedAssignments: Array<{ previous: string | null; nextId: string | null; phase: string }> = [
    { previous: row.discoveryAssigneeId, nextId: next.discoveryAssigneeId, phase: 'Discovery' },
    { previous: row.deliveryAssigneeId, nextId: next.deliveryAssigneeId, phase: 'Delivery' },
    { previous: row.technicalAssigneeId, nextId: next.technicalAssigneeId, phase: 'Technical' },
  ];

  try {
    await Promise.all(changedAssignments.map(async (assignment) => {
      if (!assignment.nextId || assignment.nextId === assignment.previous) return;
      await createNotification(assignment.nextId, {
        type: 'user-action',
        title: `Assigned to ${assignment.phase}`,
        body: `You were assigned to the ${assignment.phase} phase of the interview "${interviewTitle}".`,
        link: `/backlog/interview/${id}`,
      });
    }));
  } catch (err) {
    console.error(`[interview] Failed to notify phase assignees (interviewId=${id})`, err);
  }
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

export type InterviewEvaluationPhase = {
  phaseIndex: number;
  messages: Array<{ role: 'user' | 'agent'; text: string }>;
};

export type InterviewEvaluationInputs = {
  id: string;
  project: string;
  model: string | null;
  skillPath: string | null;
  skillVersion: string | null;
  phaseCount: number;
  currentPhase: number | null;
  phases: InterviewEvaluationPhase[];
  linkedContextIds: { adrIds: string[]; designModuleIds: string[] };
};

/** Read-only lineage and transcript slices for an evaluation. Writes nothing. */
export async function getInterviewEvaluationInputs(
  interviewId: string,
): Promise<InterviewEvaluationInputs | null> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, interviewId),
    columns: { id: true, project: true, model: true, chatThreadId: true },
  });
  if (!row) return null;

  const { getThreadAsync } = await import('./chatAgentService');
  const thread = await getThreadAsync(row.chatThreadId);
  const skillPath = thread?.kickoff?.skillPath ?? null;
  const skillVersion = thread?.groundedSha ?? null;
  const model = row.model ?? thread?.kickoff?.model ?? null;
  const messages = thread?.messages ?? [];
  const guided = usesGuidedInterview(skillPath);

  let phases: InterviewEvaluationPhase[];
  let phaseCount: number;
  let currentPhase: number | null;
  if (!guided) {
    const visible = messages.filter(
      (message) => !message.hidden && (message.role === 'user' || message.role === 'agent'),
    );
    phaseCount = 1;
    currentPhase = visible.length > 0 ? 1 : null;
    phases = visible.length > 0
      ? [{
          phaseIndex: 1,
          messages: visible.map((message) => ({
            role: message.role as 'user' | 'agent',
            text: message.text,
          })),
        }]
      : [];
  } else {
    phaseCount = 3;
    phases = sliceGuidedInterviewPhases(messages);
    currentPhase = latestGuidedInterviewPhaseIndex(messages);
  }

  const linkedContextIds = await listLinkedContextIds(row.id);
  return {
    id: row.id,
    project: row.project,
    model,
    skillPath,
    skillVersion,
    phaseCount,
    currentPhase,
    phases,
    linkedContextIds,
  };
}
