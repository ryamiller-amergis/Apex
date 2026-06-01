import { and, count, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { interviews, prds } from '../db/schema';
import type { Interview, InterviewStatus, InterviewSummary, PrdSummary } from '../../shared/types/interview';
import type { PrdStatus } from '../../shared/types/interview';
import { markAsInterviewThread } from './chatAgentService';

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
}): Promise<{ interviewId: string; threadId: string }> {
  const [row] = await db
    .insert(interviews)
    .values({
      chatThreadId: opts.chatThreadId,
      authorId: opts.userId,
      title: opts.title ?? 'Untitled Interview',
      project: opts.project,
      repo: opts.repo,
      status: 'in_progress',
    })
    .returning({ id: interviews.id });

  markAsInterviewThread(opts.chatThreadId);

  return { interviewId: row.id, threadId: opts.chatThreadId };
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
      status: interviews.status,
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

  return rows.map((row) => ({
    id: row.id,
    chatThreadId: row.chatThreadId,
    authorId: row.authorId,
    title: row.title,
    project: row.project,
    repo: row.repo,
    status: row.status as InterviewStatus,
    prdCount: prdCountMap.get(row.id) ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getInterview(id: string): Promise<Interview | null> {
  const row = await db.query.interviews.findFirst({
    where: eq(interviews.id, id),
    with: { prds: true },
  });

  if (!row) return null;

  const prdSummaries: PrdSummary[] = row.prds.map((p) => ({
    id: p.id,
    interviewId: p.interviewId,
    chatThreadId: p.chatThreadId ?? '',
    authorId: p.authorId,
    project: p.project,
    title: p.title,
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
    status: row.status as InterviewStatus,
    prdCount: row.prds.length,
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
