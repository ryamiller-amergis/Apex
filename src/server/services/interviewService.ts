import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { interviews, prds } from '../db/schema';
import type { Interview, InterviewStatus, InterviewSummary, PrdSummary } from '../../shared/types/interview';
import type { PrdStatus } from '../../shared/types/interview';
import { markAsInterviewThread } from './chatAgentService';
import { createNotification } from './notificationService';
import { getSkillSettingsName } from './projectSettingsService';

const VALID_INTERVIEW_STATUSES: InterviewStatus[] = ['in_progress', 'complete', 'archived'];

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
  skillSettingsId?: string | null;
  prdOwnerId?: string;
  designDocOwnerId?: string;
  designPrototypeOwnerId?: string;
  testCaseOwnerId?: string;
  prdApproverIds?: string[];
  designDocApproverIds?: string[];
  designPrototypeApproverIds?: string[];
  testCaseApproverIds?: string[];
}): Promise<{ interviewId: string; threadId: string }> {
  const [row] = await db
    .insert(interviews)
    .values({
      chatThreadId: opts.chatThreadId,
      authorId: opts.userId,
      title: opts.title ?? 'Untitled Interview',
      project: opts.project,
      repo: opts.repo,
      model: opts.model ?? null,
      skillSettingsId: opts.skillSettingsId ?? null,
      status: 'in_progress',
      prdOwnerId: opts.prdOwnerId ?? null,
      designDocOwnerId: opts.designDocOwnerId ?? null,
      designPrototypeOwnerId: opts.designPrototypeOwnerId ?? null,
      testCaseOwnerId: opts.testCaseOwnerId ?? null,
      prdApproverIds: opts.prdApproverIds ?? null,
      designDocApproverIds: opts.designDocApproverIds ?? null,
      designPrototypeApproverIds: opts.designPrototypeApproverIds ?? null,
      testCaseApproverIds: opts.testCaseApproverIds ?? null,
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

    if (opts.designPrototypeOwnerId) {
      notificationPromises.push(
        createNotification(opts.designPrototypeOwnerId, {
          type: 'user-action',
          title: 'Assigned as Design Prototype Owner',
          body: `You were assigned as Design Prototype owner for the interview "${interviewTitle}".`,
          link: `/backlog/interview/${interviewId}`,
        }).then(() => undefined),
      );
    }

    if (opts.testCaseOwnerId) {
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
      { userIds: opts.designPrototypeApproverIds, title: 'Assigned as Design Prototype Reviewer', role: 'Design Prototype reviewer' },
      { userIds: opts.testCaseApproverIds, title: 'Assigned as QA Reviewer', role: 'QA reviewer' },
    ];
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
      status: interviews.status,
      prdOwnerId: interviews.prdOwnerId,
      designDocOwnerId: interviews.designDocOwnerId,
      designPrototypeOwnerId: interviews.designPrototypeOwnerId,
      testCaseOwnerId: interviews.testCaseOwnerId,
      skillSettingsId: interviews.skillSettingsId,
      prdApproverIds: interviews.prdApproverIds,
      designDocApproverIds: interviews.designDocApproverIds,
      designPrototypeApproverIds: interviews.designPrototypeApproverIds,
      testCaseApproverIds: interviews.testCaseApproverIds,
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
    status: row.status as InterviewStatus,
    prdCount: prdCountMap.get(row.id) ?? 0,
    prdOwnerId: row.prdOwnerId ?? undefined,
    designDocOwnerId: row.designDocOwnerId ?? undefined,
    designPrototypeOwnerId: row.designPrototypeOwnerId ?? undefined,
    testCaseOwnerId: row.testCaseOwnerId ?? undefined,
    skillSettingsId: row.skillSettingsId ?? null,
    skillSettingsName: row.skillSettingsId ? settingsNameMap.get(row.skillSettingsId) ?? null : null,
    prdApproverIds: row.prdApproverIds ?? undefined,
    designDocApproverIds: row.designDocApproverIds ?? undefined,
    designPrototypeApproverIds: row.designPrototypeApproverIds ?? undefined,
    testCaseApproverIds: row.testCaseApproverIds ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getInterview(id: string): Promise<Interview | null> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, id),
    with: { prds: true, prdOwner: true, designDocOwner: true, designPrototypeOwner: true, testCaseOwner: true },
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

  await db
    .update(interviews)
    .set({ status: newStatus, updatedAt: new Date().toISOString() })
    .where(eq(interviews.id, id));
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
  await db.delete(interviews).where(eq(interviews.id, id));
}
