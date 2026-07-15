import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatMessageAttachments, chatMessages, chatThreads, interviews, prds } from '../db/schema';
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

export interface SearchThreadsOptions {
  term: string;
  limit?: number;
  offset?: number;
  project?: string;
  flaggedOnly?: boolean;
}

interface SearchThreadRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  title: string | null;
  status: string;
  kickoff: ChatThread['kickoff'];
  flagged: boolean;
  flagged_at: string | null;
  created_at: string;
  last_activity_at: string;
  first_user_message: string | null;
  message_id: string | null;
  message_role: string | null;
  message_text: string | null;
  matched_at: string | null;
  title_only: boolean;
}

/**
 * Search the caller's own history. The SQL selects only the newest visible
 * matching message per thread and ranks title-only matches by thread activity.
 */
export async function searchThreads(
  userId: string,
  opts: SearchThreadsOptions,
): Promise<ChatThreadSearchResult[]> {
  const term = opts.term.trim();
  const pattern = `%${term.replace(/[!%_]/g, '!$&')}%`;
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const result = await db.execute<SearchThreadRow>(sql`
    WITH eligible_threads AS (
      SELECT t.*
      FROM chat_threads t
      WHERE t.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM interviews i WHERE i.chat_thread_id = t.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM prds p WHERE p.chat_thread_id = t.id
        )
        ${opts.project ? sql`AND t.kickoff->>'project' = ${opts.project}` : sql``}
        ${opts.flaggedOnly ? sql`AND t.flagged = true` : sql``}
    ),
    message_matches AS (
      SELECT DISTINCT ON (m.thread_id)
        m.thread_id,
        m.id AS message_id,
        m.role AS message_role,
        m.text AS message_text,
        m.ts AS matched_at
      FROM chat_messages m
      INNER JOIN eligible_threads et ON et.id = m.thread_id
      WHERE m.role IN ('user', 'agent')
        AND m.hidden = false
        AND m.text ILIKE ${pattern} ESCAPE '!'
      ORDER BY m.thread_id, m.ts DESC, m.id DESC
    )
    SELECT
      et.id,
      et.user_id,
      et.title,
      et.status,
      et.kickoff,
      et.flagged,
      et.flagged_at,
      et.created_at,
      et.last_activity_at,
      (
        SELECT m.text
        FROM chat_messages m
        WHERE m.thread_id = et.id
          AND m.role = 'user'
          AND m.text <> 'Begin.'
        ORDER BY m.ts ASC
        LIMIT 1
      ) AS first_user_message,
      mm.message_id,
      mm.message_role,
      mm.message_text,
      mm.matched_at,
      (mm.message_id IS NULL) AS title_only
    FROM eligible_threads et
    LEFT JOIN message_matches mm ON mm.thread_id = et.id
    WHERE et.title ILIKE ${pattern} ESCAPE '!'
       OR mm.message_id IS NOT NULL
    ORDER BY COALESCE(mm.matched_at, et.last_activity_at) DESC, et.id DESC
    LIMIT ${limit}
    OFFSET ${offset}
  `);

  return result.rows.map((row): ChatThreadSearchResult => {
    const summary: ChatThreadSummary = {
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
      messagePreview: normalizeMessagePreview(row.first_user_message) ?? undefined,
      flagged: row.flagged,
      flaggedAt: row.flagged_at ?? undefined,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
    };

    if (
      row.message_id
      && row.message_text
      && row.matched_at
      && (row.message_role === 'user' || row.message_role === 'agent')
    ) {
      return {
        ...summary,
        match: {
          messageId: row.message_id,
          role: row.message_role,
          snippet: buildSearchSnippet(row.message_text, term),
          matchedAt: row.matched_at,
        },
        titleOnly: false,
      };
    }

    return { ...summary, titleOnly: true };
  });
}

export function buildSearchSnippet(text: string, term: string, targetLength = 120): string {
  if (text.length <= targetLength) return text;

  const matchIndex = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  const centeredStart = matchIndex >= 0
    ? matchIndex - Math.floor((targetLength - term.length) / 2)
    : 0;
  const start = Math.max(0, centeredStart);
  const end = Math.min(text.length, start + targetLength);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
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
