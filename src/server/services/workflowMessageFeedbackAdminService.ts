/**
 * Admin summary of per-message ratings: thumbs on interview questions and
 * Good / Needs improvement / Bad on home chat replies.
 */
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, chatMessages, chatThreads, interviews, workflowMessageFeedback } from '../db/schema';
import {
  CHAT_MESSAGE_RATINGS,
  INTERVIEW_MESSAGE_RATINGS,
  MESSAGE_RATING_SUMMARY_DAYS,
  type ChatMessageRating,
  type MessageRatingSummary,
  type MessageRatingSummaryDays,
} from '../../shared/types/workflowMessageFeedback';

const DEFAULT_DAYS: MessageRatingSummaryDays = 30;
const QUESTION_LIMIT = 10;
const COMMENT_LIMIT = 20;
const EXCERPT_LENGTH = 160;

export class MessageRatingSummaryRequestError extends Error {}

export function parseSummaryDays(value: unknown): MessageRatingSummaryDays {
  if (value === undefined || value === '') return DEFAULT_DAYS;
  const days = Number(value);
  if (!(MESSAGE_RATING_SUMMARY_DAYS as readonly number[]).includes(days)) {
    throw new MessageRatingSummaryRequestError(`days must be one of ${MESSAGE_RATING_SUMMARY_DAYS.join(', ')}`);
  }
  return days as MessageRatingSummaryDays;
}

export function messageExcerpt(text: string): string {
  const plain = text
    .replace(/\[\[interview-phase:[^\]]*\]\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > EXCERPT_LENGTH ? `${plain.slice(0, EXCERPT_LENGTH - 1)}…` : plain;
}

function zeroCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

export async function summarizeMessageRatings(
  project: string,
  days: MessageRatingSummaryDays,
): Promise<MessageRatingSummary> {
  const feedback = workflowMessageFeedback;
  const inWindow = sql`${feedback.updatedAt} >= now() - make_interval(days => ${days})`;
  const downCount = sql<number>`count(*) filter (where ${feedback.rating} = 'down')::int`;
  const upCount = sql<number>`count(*) filter (where ${feedback.rating} = 'up')::int`;

  const [counts, questions, comments] = await Promise.all([
    db
      .select({ surface: feedback.surface, rating: feedback.rating, count: sql<number>`count(*)::int` })
      .from(feedback)
      .where(and(eq(feedback.project, project), inWindow))
      .groupBy(feedback.surface, feedback.rating),
    db
      .select({
        interviewId: feedback.subjectId,
        interviewTitle: interviews.title,
        messageId: feedback.messageId,
        text: chatMessages.text,
        up: upCount,
        down: downCount,
      })
      .from(feedback)
      .innerJoin(chatMessages, eq(chatMessages.id, feedback.messageId))
      .innerJoin(interviews, eq(interviews.id, feedback.subjectId))
      .where(and(eq(feedback.project, project), eq(feedback.surface, 'interview'), inWindow))
      .groupBy(feedback.subjectId, interviews.title, feedback.messageId, chatMessages.text)
      .having(sql`count(*) filter (where ${feedback.rating} = 'down') > 0`)
      .orderBy(desc(downCount))
      .limit(QUESTION_LIMIT),
    db
      .select({
        threadId: feedback.subjectId,
        threadTitle: chatThreads.title,
        messageId: feedback.messageId,
        text: chatMessages.text,
        rating: feedback.rating,
        comment: feedback.comment,
        reviewerName: appUsers.displayName,
        updatedAt: feedback.updatedAt,
      })
      .from(feedback)
      .innerJoin(chatMessages, eq(chatMessages.id, feedback.messageId))
      .leftJoin(chatThreads, eq(chatThreads.id, feedback.subjectId))
      .leftJoin(appUsers, eq(appUsers.oid, feedback.userId))
      .where(and(
        eq(feedback.project, project),
        eq(feedback.surface, 'chat'),
        isNotNull(feedback.comment),
        inWindow,
      ))
      .orderBy(desc(feedback.updatedAt))
      .limit(COMMENT_LIMIT),
  ]);

  const interview = zeroCounts(INTERVIEW_MESSAGE_RATINGS);
  const chat = zeroCounts(CHAT_MESSAGE_RATINGS);
  for (const row of counts) {
    if (row.surface === 'interview' && row.rating in interview) {
      interview[row.rating as keyof typeof interview] = row.count;
    } else if (row.surface === 'chat' && row.rating in chat) {
      chat[row.rating as keyof typeof chat] = row.count;
    }
  }

  return {
    days,
    interview,
    chat,
    downvotedQuestions: questions.map(({ text, ...row }) => ({ ...row, excerpt: messageExcerpt(text) })),
    chatComments: comments.map(({ text, rating, comment, ...row }) => ({
      ...row,
      rating: rating as ChatMessageRating,
      comment: comment ?? '',
      excerpt: messageExcerpt(text),
    })),
  };
}
