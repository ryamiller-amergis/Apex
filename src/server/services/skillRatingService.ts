/**
 * Optional ratings on AI output outside Home chat and interviews. A rating is the person's current opinion,
 * so it replaces their earlier rating of the same item instead of adding another signal.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { skillSignals } from '../db/schema';
import { threadProvenance } from './skillSignalService';
import {
  CHAT_MESSAGE_RATINGS,
  WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH,
  chatRatingNeedsComment,
  type ChatMessageRating,
} from '../../shared/types/workflowMessageFeedback';
import {
  SKILL_RATING_SURFACES,
  type SkillRatingEntry,
  type SkillRatingSurface,
  type PutSkillRatingRequest,
} from '../../shared/types/skillRating';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 200;
const MAX_SUBJECTS = 200;

export class SkillRatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillRatingError';
  }
}

const VALUE_FOR_RATING: Record<ChatMessageRating, -1 | 0 | 1> = { good: 1, needs_improvement: 0, bad: -1 };

function ratingForValue(value: number | null): ChatMessageRating | null {
  switch (value) {
    case 1:
      return 'good';
    case 0:
      return 'needs_improvement';
    case -1:
      return 'bad';
    default:
      return null;
  }
}

export function isSkillRatingSurface(value: unknown): value is SkillRatingSurface {
  return (SKILL_RATING_SURFACES as readonly unknown[]).includes(value);
}

function validId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_LENGTH) {
    throw new SkillRatingError(`${field} is required`);
  }
  return value.trim();
}

export function parsePutSkillRating(body: unknown): PutSkillRatingRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  if (!isSkillRatingSurface(input.surface)) throw new SkillRatingError(`surface must be one of ${SKILL_RATING_SURFACES.join(', ')}`);
  const subjectType = validId(input.subjectType, 'subjectType');
  const subjectId = validId(input.subjectId, 'subjectId');
  if (input.threadId != null && (typeof input.threadId !== 'string' || !UUID.test(input.threadId))) {
    throw new SkillRatingError('threadId must be a chat thread id');
  }
  if (input.rating !== null && !(CHAT_MESSAGE_RATINGS as readonly unknown[]).includes(input.rating)) {
    throw new SkillRatingError(`rating must be null or one of ${CHAT_MESSAGE_RATINGS.join(', ')}`);
  }
  const rating = input.rating as ChatMessageRating | null;
  const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
  if (comment.length > WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH) throw new SkillRatingError('comment is too long');
  if (rating && chatRatingNeedsComment(rating) && !comment) throw new SkillRatingError('A comment is required for this rating');
  return {
    surface: input.surface,
    subjectType,
    subjectId,
    threadId: (input.threadId as string | null | undefined) ?? null,
    rating,
    comment: comment || null,
  };
}

function ratingKey(project: string, surface: SkillRatingSurface, subjectId: string, userId: string): string {
  return `rating:${project}:${surface}:${subjectId}:${userId}`;
}

export async function putSkillRating(project: string, userId: string, request: PutSkillRatingRequest): Promise<SkillRatingEntry | null> {
  const idempotencyKey = ratingKey(project, request.surface, request.subjectId, userId);
  if (request.rating === null) {
    await db.delete(skillSignals).where(eq(skillSignals.idempotencyKey, idempotencyKey));
    return null;
  }
  const provenance = request.threadId
    ? await threadProvenance(request.threadId)
    : { skillPath: null, skillSha256: null, model: null, effort: null };
  const value = VALUE_FOR_RATING[request.rating];
  // skill_signals rejects UPDATE, so a changed rating replaces the row.
  await db.transaction(async (tx) => {
    await tx.delete(skillSignals).where(eq(skillSignals.idempotencyKey, idempotencyKey));
    await tx.insert(skillSignals).values({
      project,
      surface: request.surface,
      subjectType: request.subjectType,
      subjectId: request.subjectId,
      threadId: request.threadId,
      skillPath: provenance.skillPath,
      skillSha256: provenance.skillSha256,
      model: provenance.model,
      effort: provenance.effort,
      kind: 'rating',
      value,
      actorId: userId,
      comment: request.comment,
      metadata: {},
      idempotencyKey,
    });
  });
  return { subjectId: request.subjectId, rating: request.rating, comment: request.comment };
}

/** The signed-in person's ratings for the given items on one surface. */
export async function listMySkillRatings(
  project: string,
  userId: string,
  surface: SkillRatingSurface,
  subjectIds: readonly string[],
): Promise<SkillRatingEntry[]> {
  const ids = [...new Set(subjectIds.map((id) => id.trim()).filter(Boolean))].slice(0, MAX_SUBJECTS);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ subjectId: skillSignals.subjectId, value: skillSignals.value, comment: skillSignals.comment })
    .from(skillSignals)
    .where(and(
      eq(skillSignals.project, project),
      eq(skillSignals.surface, surface),
      eq(skillSignals.kind, 'rating'),
      eq(skillSignals.actorId, userId),
      inArray(skillSignals.subjectId, ids),
      isNotNull(skillSignals.value),
    ));
  return rows.flatMap((row) => {
    const rating = ratingForValue(row.value);
    return rating ? [{ subjectId: row.subjectId, rating, comment: row.comment }] : [];
  });
}
