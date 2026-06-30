import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatMessageAttachments, chatMessages, chatThreads, interviews, prds } from '../db/schema';
import type {
  ChatMessage,
  ChatThread,
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
