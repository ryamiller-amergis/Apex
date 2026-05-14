import { asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatMessageAttachments, chatMessages, chatThreads } from '../db/schema';
import type {
  ChatMessage,
  ChatThread,
  ChatThreadSummary,
} from '../../shared/types/chat';

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
  opts?: { limit?: number; offset?: number },
): Promise<ChatThreadSummary[]> {
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

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
    })
    .from(chatThreads)
    .where(eq(chatThreads.userId, userId))
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
    },
    flagged: row.flagged,
    flaggedAt: row.flaggedAt ?? undefined,
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

// ── helpers ───────────────────────────────────────────────────────────────────

function deriveTitle(thread: ChatThread): string {
  if (thread.kickoff.skillPath) {
    const parts = thread.kickoff.skillPath.split('/');
    const skillFolder = parts[parts.length - 2] ?? parts[parts.length - 1] ?? 'Skill';
    return skillFolder.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  const firstUserMsg = thread.messages.find((m) => m.role === 'user');
  if (firstUserMsg?.text) {
    return firstUserMsg.text.slice(0, 80).replace(/\n/g, ' ').trim();
  }

  return 'Free chat';
}
