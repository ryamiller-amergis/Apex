/**
 * Per-message feedback on agent replies. Rows are the caller's own rating; a
 * second rating on the same message replaces the first. No judge runs.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatMessages, chatThreads, interviews, workflowMessageFeedback } from '../db/schema';
import {
  CHAT_MESSAGE_RATINGS,
  INTERVIEW_MESSAGE_RATINGS,
  WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH,
  WORKFLOW_MESSAGE_FEEDBACK_SURFACES,
  chatRatingNeedsComment,
  type ListWorkflowMessageFeedbackResponse,
  type PutWorkflowMessageFeedbackRequest,
  type PutWorkflowMessageFeedbackResponse,
  type WorkflowMessageFeedbackEntry,
  type WorkflowMessageFeedbackSurface,
  type WorkflowMessageRating,
} from '../../shared/types/workflowMessageFeedback';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class WorkflowMessageFeedbackError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: string;

  constructor(status: 404 | 409 | 422, code: string, message: string) {
    super(message);
    this.name = 'WorkflowMessageFeedbackError';
    this.status = status;
    this.code = code;
  }
}

interface ResolvedSubject {
  threadId: string;
  open: boolean;
}

function isSurface(value: unknown): value is WorkflowMessageFeedbackSurface {
  return (WORKFLOW_MESSAGE_FEEDBACK_SURFACES as readonly unknown[]).includes(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

async function resolveInterviewSubject(project: string, interviewId: string): Promise<ResolvedSubject> {
  const [row] = await db
    .select({ project: interviews.project, threadId: interviews.chatThreadId, status: interviews.status })
    .from(interviews)
    .where(eq(interviews.id, interviewId))
    .limit(1);
  if (!row || row.project !== project) {
    throw new WorkflowMessageFeedbackError(404, 'SUBJECT_NOT_FOUND', 'Interview not found.');
  }
  return { threadId: row.threadId, open: row.status === 'in_progress' };
}

/** Only the person who owns the chat rates its replies. */
async function resolveChatSubject(project: string, threadId: string, userId: string): Promise<ResolvedSubject> {
  const [row] = await db
    .select({ userId: chatThreads.userId, kickoff: chatThreads.kickoff })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row || row.userId !== userId || row.kickoff?.project !== project) {
    throw new WorkflowMessageFeedbackError(404, 'SUBJECT_NOT_FOUND', 'Chat not found.');
  }
  return { threadId, open: true };
}

async function resolveSubject(
  project: string,
  surface: WorkflowMessageFeedbackSurface,
  subjectId: string,
  userId: string,
): Promise<ResolvedSubject> {
  switch (surface) {
    case 'interview':
      return resolveInterviewSubject(project, subjectId);
    case 'chat':
      return resolveChatSubject(project, subjectId, userId);
    default: {
      const unhandled: never = surface;
      return unhandled;
    }
  }
}

function isRatingForSurface(surface: WorkflowMessageFeedbackSurface, rating: unknown): rating is WorkflowMessageRating {
  switch (surface) {
    case 'interview':
      return (INTERVIEW_MESSAGE_RATINGS as readonly unknown[]).includes(rating);
    case 'chat':
      return (CHAT_MESSAGE_RATINGS as readonly unknown[]).includes(rating);
    default: {
      const unhandled: never = surface;
      return unhandled;
    }
  }
}

function toEntry(row: typeof workflowMessageFeedback.$inferSelect): WorkflowMessageFeedbackEntry {
  return {
    messageId: row.messageId,
    rating: row.rating,
    comment: row.comment,
    updatedAt: row.updatedAt,
  };
}

export function parseListQuery(query: Record<string, unknown>): {
  surface: WorkflowMessageFeedbackSurface;
  subjectId: string;
} {
  if (!isSurface(query.surface)) {
    throw new WorkflowMessageFeedbackError(422, 'UNKNOWN_FIELD', 'surface is invalid');
  }
  if (!isUuid(query.subjectId)) {
    throw new WorkflowMessageFeedbackError(422, 'UNKNOWN_FIELD', 'subjectId is invalid');
  }
  return { surface: query.surface, subjectId: query.subjectId };
}

export function parsePutBody(body: unknown): PutWorkflowMessageFeedbackRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  if (!isSurface(value.surface)) {
    throw new WorkflowMessageFeedbackError(422, 'UNKNOWN_FIELD', 'surface is invalid');
  }
  if (!isUuid(value.subjectId)) {
    throw new WorkflowMessageFeedbackError(422, 'UNKNOWN_FIELD', 'subjectId is invalid');
  }
  if (value.rating !== null && !isRatingForSurface(value.surface, value.rating)) {
    throw new WorkflowMessageFeedbackError(422, 'INVALID_RATING', 'rating is invalid for this surface');
  }
  if (value.surface === 'interview' && value.comment != null) {
    throw new WorkflowMessageFeedbackError(422, 'UNKNOWN_FIELD', 'Interview ratings take no comment.');
  }
  if (value.comment != null && typeof value.comment !== 'string') {
    throw new WorkflowMessageFeedbackError(422, 'UNKNOWN_FIELD', 'comment must be text');
  }
  const rating = value.rating as WorkflowMessageRating | null;
  const comment = rating === null ? null : (value.comment as string | null | undefined)?.trim() || null;
  if (comment && comment.length > WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH) {
    throw new WorkflowMessageFeedbackError(
      422,
      'COMMENT_TOO_LONG',
      `Keep the comment under ${WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH} characters.`,
    );
  }
  if (!comment && rating !== null && chatRatingNeedsComment(rating)) {
    throw new WorkflowMessageFeedbackError(422, 'COMMENT_REQUIRED', 'Say what the agent could do better.');
  }
  return { surface: value.surface, subjectId: value.subjectId, rating, comment };
}

export async function listMyMessageFeedback(
  project: string,
  userId: string,
  surface: WorkflowMessageFeedbackSurface,
  subjectId: string,
): Promise<ListWorkflowMessageFeedbackResponse> {
  await resolveSubject(project, surface, subjectId, userId);
  const rows = await db
    .select()
    .from(workflowMessageFeedback)
    .where(and(
      eq(workflowMessageFeedback.project, project),
      eq(workflowMessageFeedback.surface, surface),
      eq(workflowMessageFeedback.subjectId, subjectId),
      eq(workflowMessageFeedback.userId, userId),
    ));
  return { surface, subjectId, entries: rows.map(toEntry) };
}

export async function putMessageFeedback(
  project: string,
  userId: string,
  messageId: string,
  request: PutWorkflowMessageFeedbackRequest,
): Promise<PutWorkflowMessageFeedbackResponse> {
  if (!isUuid(messageId)) {
    throw new WorkflowMessageFeedbackError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  }
  const subject = await resolveSubject(project, request.surface, request.subjectId, userId);
  if (!subject.open) {
    throw new WorkflowMessageFeedbackError(409, 'SUBJECT_CLOSED', 'Ratings are closed for this interview.');
  }
  const [message] = await db
    .select({ threadId: chatMessages.threadId, role: chatMessages.role })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
    .limit(1);
  if (!message || message.threadId !== subject.threadId) {
    throw new WorkflowMessageFeedbackError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  }
  if (message.role !== 'agent') {
    throw new WorkflowMessageFeedbackError(422, 'NOT_AGENT_MESSAGE', 'Only agent replies can be rated.');
  }

  if (request.rating === null) {
    await db
      .delete(workflowMessageFeedback)
      .where(and(eq(workflowMessageFeedback.messageId, messageId), eq(workflowMessageFeedback.userId, userId)));
    return { entry: null };
  }

  const comment = request.comment ?? null;
  const [row] = await db
    .insert(workflowMessageFeedback)
    .values({
      project,
      surface: request.surface,
      subjectId: request.subjectId,
      messageId,
      userId,
      rating: request.rating,
      comment,
    })
    .onConflictDoUpdate({
      target: [workflowMessageFeedback.messageId, workflowMessageFeedback.userId],
      set: { rating: request.rating, comment, updatedAt: sql`now()` },
    })
    .returning();
  return { entry: toEntry(row) };
}
