import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatMessageAttachments, chatMessages, chatThreads, interviews } from '../db/schema';
import type {
  ChatMessage,
  ChatThread,
  ChatThreadSearchResult,
  ChatThreadSummary,
} from '../../shared/types/chat';
import {
  formatProcessDescription,
  firstUserMessagePreview,
  normalizeMessagePreview,
  skillPathToProcessLabel,
} from '../../shared/utils/threadHistoryLabel';

const SNIPPET_WINDOW = 120;

/** Escape `%`, `_`, and `\` so ILIKE performs a plain substring match. */
export function escapeIlikePattern(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Center a ~120-char window on the first case-insensitive hit.
 * Clamp to message bounds; ellipsis only when the window is clipped (A-007).
 */
export function deriveMatchSnippet(text: string, term: string, window = SNIPPET_WINDOW): string {
  if (!text) return '';
  if (text.length <= window) return text;

  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  const hitIndex = lowerText.indexOf(lowerTerm);
  const anchor = hitIndex >= 0 ? hitIndex : 0;
  const half = Math.floor(window / 2);

  let start = Math.max(0, anchor - half);
  const end = Math.min(text.length, start + window);
  start = Math.max(0, end - window);

  let snippet = text.slice(start, end);
  if (start > 0) snippet = `...${snippet}`;
  if (end < text.length) snippet = `${snippet}...`;
  return snippet;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

interface SearchThreadRow {
  id: string;
  user_id: string;
  title: string | null;
  status: string;
  kickoff: ChatThread['kickoff'] | null;
  flagged: boolean;
  flagged_at: string | null;
  created_at: string;
  last_activity_at: string;
  message_id: string | null;
  match_role: string | null;
  message_text: string | null;
  matched_at: string | null;
  title_only: boolean;
  first_user_message: string | null;
}

export interface SearchThreadsOpts {
  term: string;
  limit?: number;
  offset?: number;
  project?: string;
  flaggedOnly?: boolean;
}

// ── upsertThread ──────────────────────────────────────────────────────────────

export async function upsertThread(thread: ChatThread): Promise<void> {
  await db
    .insert(chatThreads)
    .values({
      id: thread.id,
      userId: thread.userId,
      status: thread.status,
      kickoff: thread.kickoff,
      cursorAgentId: thread.cursorAgentId ?? null,
      groundingMode: thread.groundingMode ?? null,
      groundedSha: thread.groundedSha ?? null,
      workspaceDir: thread.workspaceDir,
      lastError: thread.lastError ?? null,
      savedWikiUrl: thread.savedWikiUrl ?? null,
      title: deriveTitle(thread),
      activeRunId: thread.activeRunId ?? null,
      createdAt: thread.createdAt,
      lastActivityAt: thread.lastActivityAt,
    })
    .onConflictDoUpdate({
      target: chatThreads.id,
      set: {
        status: thread.status,
        kickoff: thread.kickoff,
        cursorAgentId: thread.cursorAgentId ?? null,
        groundingMode: thread.groundingMode ?? null,
        groundedSha: thread.groundedSha ?? null,
        workspaceDir: thread.workspaceDir,
        lastError: thread.lastError ?? null,
        savedWikiUrl: thread.savedWikiUrl ?? null,
        title: deriveTitle(thread),
        activeRunId: thread.activeRunId ?? null,
        lastActivityAt: thread.lastActivityAt,
      },
    });
}

// ── insertMessage ─────────────────────────────────────────────────────────────

export async function insertMessage(
  threadId: string,
  msg: ChatMessage,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(chatMessages)
      .values({
        id: msg.id,
        threadId,
        role: msg.role,
        text: msg.text,
        toolName: msg.toolName ?? null,
        hidden: msg.hidden ?? false,
        ts: msg.ts,
      })
      .onConflictDoNothing();

    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        await tx
          .insert(chatMessageAttachments)
          .values({
            id: att.id,
            messageId: msg.id,
            name: att.name,
            type: att.type,
            size: att.size,
            path: att.path ?? null,
          })
          .onConflictDoNothing();
      }
    }
  });
}

// ── listThreadsByUser ─────────────────────────────────────────────────────────

export async function listThreadsByUser(
  userId: string,
  opts?: { limit?: number; offset?: number; project?: string },
): Promise<ChatThreadSummary[]> {
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const conditions = [
    eq(chatThreads.userId, userId),
    sql`NOT EXISTS (SELECT 1 FROM interviews WHERE interviews.chat_thread_id = ${chatThreads.id})`,
    sql`NOT EXISTS (SELECT 1 FROM prds WHERE prds.chat_thread_id = ${chatThreads.id})`,
  ];

  if (opts?.project) {
    conditions.push(sql`${chatThreads.kickoff}->>'project' = ${opts.project}`);
  }

  const rows = await db
    .select({
      id: chatThreads.id,
      userId: chatThreads.userId,
      title: chatThreads.title,
      status: chatThreads.status,
      kickoff: chatThreads.kickoff,
      flagged: chatThreads.flagged,
      flaggedAt: chatThreads.flaggedAt,
      createdAt: chatThreads.createdAt,
      lastActivityAt: chatThreads.lastActivityAt,
      firstUserMessage: sql<string | null>`(
        SELECT m.text FROM chat_messages m
        WHERE m.thread_id = ${chatThreads.id}
          AND m.role = 'user'
          AND m.text <> 'Begin.'
        ORDER BY m.ts ASC
        LIMIT 1
      )`.as('first_user_message'),
    })
    .from(chatThreads)
    .where(and(...conditions))
    .orderBy(desc(chatThreads.lastActivityAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    title: row.title ?? 'Untitled',
    status: row.status as ChatThreadSummary['status'],
    kickoff: {
      project: row.kickoff?.project ?? '',
      repo: row.kickoff?.repo ?? '',
      skillPath: row.kickoff?.skillPath,
      pillLabel: row.kickoff?.pillLabel,
      pillDescription: row.kickoff?.pillDescription,
    },
    flagged: row.flagged,
    flaggedAt: row.flaggedAt ?? undefined,
    messagePreview: normalizeMessagePreview(row.firstUserMessage) ?? undefined,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
  }));
}

// ── searchThreads ─────────────────────────────────────────────────────────────

/**
 * User-scoped chat history search (FEAT-001 / TBI-002).
 * Matches thread title + visible user/agent message text; one row per thread.
 */
export async function searchThreads(
  userId: string,
  opts: SearchThreadsOpts,
): Promise<ChatThreadSearchResult[]> {
  const term = opts.term.trim();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const pattern = `%${escapeIlikePattern(term)}%`;

  const projectFilter = opts.project
    ? sql`AND t.kickoff->>'project' = ${opts.project}`
    : sql``;
  const flaggedFilter = opts.flaggedOnly
    ? sql`AND t.flagged = true`
    : sql``;

  const result = await db.execute(sql`
    WITH scoped_threads AS (
      SELECT t.*
      FROM chat_threads t
      WHERE t.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM interviews WHERE interviews.chat_thread_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM prds WHERE prds.chat_thread_id = t.id
        )
        ${projectFilter}
        ${flaggedFilter}
    ),
    message_hits AS (
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id,
        m.id AS message_id,
        m.role AS match_role,
        m.text AS message_text,
        m.ts AS matched_at
      FROM chat_messages m
      INNER JOIN scoped_threads st ON st.id = m.thread_id
      WHERE m.role IN ('user', 'agent')
        AND m.hidden = false
        AND m.text ILIKE ${pattern} ESCAPE '\\'
      ORDER BY m.thread_id, m.ts DESC
    ),
    title_hits AS (
      SELECT st.id AS thread_id
      FROM scoped_threads st
      WHERE st.title ILIKE ${pattern} ESCAPE '\\'
        AND NOT EXISTS (
          SELECT 1 FROM message_hits mh WHERE mh.thread_id = st.id
        )
    ),
    matched AS (
      SELECT
        st.id,
        st.user_id,
        st.title,
        st.status,
        st.kickoff,
        st.flagged,
        st.flagged_at,
        st.created_at,
        st.last_activity_at,
        mh.message_id,
        mh.match_role,
        mh.message_text,
        mh.matched_at,
        false AS title_only,
        mh.matched_at AS sort_at
      FROM scoped_threads st
      INNER JOIN message_hits mh ON mh.thread_id = st.id

      UNION ALL

      SELECT
        st.id,
        st.user_id,
        st.title,
        st.status,
        st.kickoff,
        st.flagged,
        st.flagged_at,
        st.created_at,
        st.last_activity_at,
        NULL::uuid AS message_id,
        NULL::text AS match_role,
        NULL::text AS message_text,
        NULL::timestamptz AS matched_at,
        true AS title_only,
        st.last_activity_at AS sort_at
      FROM scoped_threads st
      INNER JOIN title_hits th ON th.thread_id = st.id
    )
    SELECT
      m.*,
      (
        SELECT msg.text FROM chat_messages msg
        WHERE msg.thread_id = m.id
          AND msg.role = 'user'
          AND msg.text <> 'Begin.'
        ORDER BY msg.ts ASC
        LIMIT 1
      ) AS first_user_message
    FROM matched m
    ORDER BY m.sort_at DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  return resultRows<SearchThreadRow>(result).map((row) => mapSearchRow(row, term));
}

function mapSearchRow(row: SearchThreadRow, term: string): ChatThreadSearchResult {
  const summary: ChatThreadSearchResult = {
    id: row.id,
    userId: row.user_id,
    title: row.title ?? 'Untitled',
    status: row.status as ChatThreadSummary['status'],
    kickoff: {
      project: row.kickoff?.project ?? '',
      repo: row.kickoff?.repo ?? '',
      skillPath: row.kickoff?.skillPath,
      pillLabel: row.kickoff?.pillLabel,
      pillDescription: row.kickoff?.pillDescription,
    },
    flagged: row.flagged,
    flaggedAt: row.flagged_at ?? undefined,
    messagePreview: normalizeMessagePreview(row.first_user_message) ?? undefined,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
  };

  if (row.title_only || !row.message_id || !row.message_text || !row.matched_at) {
    return { ...summary, titleOnly: true };
  }

  const role = row.match_role === 'agent' ? 'agent' : 'user';
  return {
    ...summary,
    titleOnly: false,
    match: {
      messageId: row.message_id,
      role,
      snippet: deriveMatchSnippet(row.message_text, term),
      matchedAt: row.matched_at,
    },
  };
}

// ── loadFullThread ────────────────────────────────────────────────────────────

export async function loadFullThread(threadId: string): Promise<ChatThread | null> {
  const result = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    with: {
      messages: {
        orderBy: asc(chatMessages.ts),
        with: { attachments: true },
      },
    },
  });

  if (!result) return null;

  const messages: ChatMessage[] = result.messages.map((m) => ({
    id: m.id,
    role: m.role as ChatMessage['role'],
    text: m.text,
    toolName: m.toolName ?? undefined,
    hidden: m.hidden || undefined,
    ts: m.ts,
    attachments:
      m.attachments.length > 0
        ? m.attachments.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            size: a.size,
            path: a.path ?? undefined,
          }))
        : undefined,
  }));

  return {
    id: result.id,
    userId: result.userId,
    status: result.status as ChatThread['status'],
    kickoff: result.kickoff,
    cursorAgentId: result.cursorAgentId ?? undefined,
    groundingMode: (result.groundingMode as ChatThread['groundingMode']) ?? undefined,
    groundedSha: result.groundedSha ?? null,
    activeRunId: result.activeRunId ?? undefined,
    workspaceDir: result.workspaceDir ?? '',
    lastError: result.lastError ?? undefined,
    savedWikiUrl: result.savedWikiUrl ?? undefined,
    flagged: result.flagged,
    flaggedAt: result.flaggedAt ?? undefined,
    messages,
    createdAt: result.createdAt,
    lastActivityAt: result.lastActivityAt,
  };
}

// ── deleteThread ──────────────────────────────────────────────────────────────

export async function deleteThread(threadId: string): Promise<void> {
  await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
}

// ── toggleFlag ────────────────────────────────────────────────────────

export async function toggleFlag(
  threadId: string,
  flagged: boolean,
): Promise<{ flagged: boolean; flaggedAt: string | null }> {
  const flaggedAt = flagged ? new Date().toISOString() : null;
  await db
    .update(chatThreads)
    .set({ flagged, flaggedAt })
    .where(eq(chatThreads.id, threadId));
  return { flagged, flaggedAt };
}

// ── recovery helpers ──────────────────────────────────────────────────────────

export interface StuckInterviewThread {
  threadId: string;
  interviewId: string;
  activeRunId: string | null;
}

/**
 * Find chat_threads stuck in 'running' status that are linked to an interview.
 * Used by startup recovery to detect interview agents that died mid-flight.
 */
export async function findRunningInterviewThreads(): Promise<StuckInterviewThread[]> {
  const rows = await db
    .select({
      threadId: chatThreads.id,
      interviewId: interviews.id,
      activeRunId: chatThreads.activeRunId,
    })
    .from(chatThreads)
    .innerJoin(interviews, eq(interviews.chatThreadId, chatThreads.id))
    .where(eq(chatThreads.status, 'running'));

  return rows.map((r) => ({
    threadId: r.threadId,
    interviewId: r.interviewId,
    activeRunId: r.activeRunId,
  }));
}

/**
 * Reset a thread from 'running' to 'idle' and clear its active_run_id.
 * Used by startup recovery after hydrating a thread that was stuck.
 */
export async function clearStaleRun(threadId: string): Promise<void> {
  await db
    .update(chatThreads)
    .set({ status: 'idle', activeRunId: null })
    .where(eq(chatThreads.id, threadId));
}

/** Lightweight read of the thread's persisted Cursor agent id (interactive resume). */
export async function getCursorAgentId(
  threadId: string,
): Promise<string | null> {
  const rows = await db
    .select({ cursorAgentId: chatThreads.cursorAgentId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return rows[0]?.cursorAgentId ?? null;
}

/** Persist Cursor agent id for interactive restart recovery (null clears). */
export async function setCursorAgentId(
  threadId: string,
  cursorAgentId: string | null,
): Promise<void> {
  await db
    .update(chatThreads)
    .set({ cursorAgentId })
    .where(eq(chatThreads.id, threadId));
}

// ── helpers ───────────────────────────────────────────────────────────────────

function deriveTitle(thread: ChatThread): string {
  const promptPreview = firstUserMessagePreview(thread.messages);

  // 1. Pill label + pill description or first user prompt
  if (thread.kickoff.pillLabel) {
    const desc = promptPreview || thread.kickoff.pillDescription?.trim();
    return formatProcessDescription(thread.kickoff.pillLabel, desc || undefined);
  }

  // 2. Skill folder name + first user prompt
  if (thread.kickoff.skillPath) {
    const process = skillPathToProcessLabel(thread.kickoff.skillPath);
    return formatProcessDescription(process, promptPreview);
  }

  // 3. Fall back to first user message
  if (promptPreview) return promptPreview;

  return 'Free chat';
}
