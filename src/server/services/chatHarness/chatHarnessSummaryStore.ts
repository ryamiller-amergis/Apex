/**
 * Persistence helpers for per-thread conversation summaries (`chat_thread_summaries`).
 *
 * BR-005 / BR-007: Summaries come only from SDK auto-summary and user Summarize;
 * fallback summaries are saved for UI warning markers but never selected for
 * agent recreation. Summary text is never logged.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { chatMessages, chatThreadSummaries } from '../../db/schema';
import type { HarnessSummaryMarker } from '../../../shared/types/chatHarness';

export interface HarnessSummaryRecord {
  id: string;
  threadId: string;
  runId: string;
  summaryText: string;
  source: 'auto' | 'user';
  isFallback: boolean;
  coversThroughOrdinal: number;
  createdAt: string;
}

export interface SaveSummaryInput {
  threadId: string;
  runId: string;
  summaryText: string;
  source: 'auto' | 'user';
  isFallback: boolean;
  coversThroughOrdinal: number;
}

function mapSummaryRow(
  row: typeof chatThreadSummaries.$inferSelect,
): HarnessSummaryRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    runId: row.runId,
    summaryText: row.summaryText,
    source: row.source,
    isFallback: row.isFallback,
    coversThroughOrdinal: row.coversThroughOrdinal,
    createdAt: row.createdAt,
  };
}

/**
 * Persist a completed or fallback summary for a thread.
 * Never logs `summaryText`.
 */
export async function saveSummary(
  input: SaveSummaryInput,
): Promise<HarnessSummaryRecord> {
  if (typeof input.summaryText !== 'string' || input.summaryText.trim().length === 0) {
    throw new Error('Summary text must be a non-empty string');
  }
  if (
    !Number.isSafeInteger(input.coversThroughOrdinal) ||
    input.coversThroughOrdinal < 0
  ) {
    throw new Error('coversThroughOrdinal must be a non-negative integer');
  }

  const [inserted] = await db
    .insert(chatThreadSummaries)
    .values({
      threadId: input.threadId,
      runId: input.runId,
      summaryText: input.summaryText,
      source: input.source,
      isFallback: input.isFallback,
      coversThroughOrdinal: input.coversThroughOrdinal,
    })
    .returning();

  if (!inserted) {
    throw new Error('Failed to insert chat thread summary');
  }
  return mapSummaryRow(inserted);
}

/**
 * Return the newest non-fallback summary for recreation.
 * Queries `WHERE thread_id = $1 AND is_fallback = false ORDER BY created_at DESC LIMIT 1`
 * to hit the partial index `idx_chat_thread_summaries_latest_full`.
 */
export async function getLatestNonFallbackSummary(
  threadId: string,
): Promise<HarnessSummaryRecord | null> {
  const rows = await db
    .select()
    .from(chatThreadSummaries)
    .where(
      and(
        eq(chatThreadSummaries.threadId, threadId),
        eq(chatThreadSummaries.isFallback, false),
      ),
    )
    .orderBy(desc(chatThreadSummaries.createdAt))
    .limit(1);

  const row = rows[0];
  return row ? mapSummaryRow(row) : null;
}

/**
 * Return metadata for the latest summary row (including fallback rows so the UI
 * can show a fallback warning). Never selects or returns `summaryText`.
 */
export async function getLatestSummaryMarker(
  threadId: string,
): Promise<HarnessSummaryMarker | null> {
  const rows = await db
    .select({
      id: chatThreadSummaries.id,
      source: chatThreadSummaries.source,
      isFallback: chatThreadSummaries.isFallback,
      createdAt: chatThreadSummaries.createdAt,
    })
    .from(chatThreadSummaries)
    .where(eq(chatThreadSummaries.threadId, threadId))
    .orderBy(desc(chatThreadSummaries.createdAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    fallback: row.isFallback,
    createdAt: row.createdAt,
  };
}

/**
 * Compute the 1-based ordinal of the last visible (non-hidden user/agent,
 * non-reasoning) message in `(ts, id)` order strictly before `beforeMessageId`.
 * When `beforeMessageId` is null/undefined or absent (e.g. a summarize operation
 * with no user message row), counts all visible messages in the thread.
 */
export async function countVisibleMessagesBefore(
  threadId: string,
  beforeMessageId?: string | null,
): Promise<number> {
  const rows = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      hidden: chatMessages.hidden,
      toolName: chatMessages.toolName,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.ts), asc(chatMessages.id));

  let count = 0;
  for (const row of rows) {
    if (beforeMessageId && row.id === beforeMessageId) {
      break;
    }
    if (
      !row.hidden &&
      (row.role === 'user' || row.role === 'agent') &&
      row.toolName !== '_reasoning'
    ) {
      count += 1;
    }
  }
  return count;
}

export const chatHarnessSummaryStore = {
  saveSummary,
  getLatestNonFallbackSummary,
  getLatestSummaryMarker,
  countVisibleMessagesBefore,
};
