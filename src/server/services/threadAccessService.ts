import { eq, or } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { adrs, designDocs, interviews, prds } from '../db/schema';
import type { ChatThread } from '../../shared/types/chat';
import { loadFullThread } from './chatThreadRepository';
import { getThread } from './chatAgentService';
import { getUserPermissions } from './rbacService';
import { isAdminUser } from '../utils/rbacHelpers';
import { isAssignedApprover } from './documentApprovalService';

export type ThreadAccess = 'owner' | 'read';

export interface ThreadAccessResult {
  access: ThreadAccess;
  thread: ChatThread;
}

type ThreadLinkKind =
  | 'interview'
  | 'technical_phase'
  | 'adr'
  | 'adr_assistant'
  | 'prd'
  | 'design_doc'
  | 'design_doc_qa'
  | 'design_doc_assistant'
  | 'design_doc_validation';

interface ThreadLink {
  kind: ThreadLinkKind;
  documentId: string;
}

async function findThreadLink(threadId: string): Promise<ThreadLink | null> {
  const interview = await db.query.interviews.findFirst({
    where: or(
      eq(interviews.chatThreadId, threadId),
      eq(interviews.technicalPhaseChatThreadId, threadId),
    ),
    columns: {
      id: true,
      chatThreadId: true,
      technicalPhaseChatThreadId: true,
    },
  });
  if (interview?.technicalPhaseChatThreadId === threadId) {
    return { kind: 'technical_phase', documentId: interview.id };
  }
  if (interview) return { kind: 'interview', documentId: interview.id };

  const prd = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
    columns: { id: true },
  });
  if (prd) return { kind: 'prd', documentId: prd.id };

  const adr = await db.query.adrs.findFirst({
    where: or(
      eq(adrs.chatThreadId, threadId),
      eq(adrs.adrAssistantThreadId, threadId),
    ),
    columns: { id: true, chatThreadId: true, adrAssistantThreadId: true },
  });
  if (adr?.chatThreadId === threadId) return { kind: 'adr', documentId: adr.id };
  if (adr?.adrAssistantThreadId === threadId) return { kind: 'adr_assistant', documentId: adr.id };

  const doc = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.docAssistantThreadId, threadId),
      eq(designDocs.validationThreadId, threadId),
    ),
    columns: {
      id: true,
      chatThreadId: true,
      docAssistantThreadId: true,
      validationThreadId: true,
    },
  });
  if (!doc) return null;

  if (doc.chatThreadId === threadId) return { kind: 'design_doc', documentId: doc.id };
  if (doc.docAssistantThreadId === threadId) return { kind: 'design_doc_assistant', documentId: doc.id };
  if (doc.validationThreadId === threadId) return { kind: 'design_doc_validation', documentId: doc.id };

  return null;
}

async function userCanReadLinkedThread(userId: string): Promise<boolean> {
  const perms = await getUserPermissions(userId);
  return perms.has('interviews:view') || perms.has('chat:view_all');
}

/**
 * Resolve read access to a chat thread. Returns null when the thread does not
 * exist or the user may not read it (callers should respond with 404).
 */
export async function resolveThreadAccess(
  userId: string,
  threadId: string,
): Promise<ThreadAccessResult | null> {
  // Prefer in-memory thread (has the latest messages even before Postgres
  // inserts complete), fall back to Postgres for cold / restarted threads.
  const thread = (await getThread(threadId)) ?? (await loadFullThread(threadId));
  if (!thread) return null;

  if (thread.userId === userId) {
    return { access: 'owner', thread };
  }

  const perms = await getUserPermissions(userId);
  if (perms.has('chat:view_all')) {
    return { access: 'read', thread };
  }

  const link = await findThreadLink(threadId);
  if (!link) return null;

  if ((link.kind === 'adr' || link.kind === 'adr_assistant') && perms.has('adr:view')) {
    return { access: 'read', thread };
  }

  if (perms.has('interviews:view')) {
    return { access: 'read', thread };
  }

  return null;
}

/**
 * Whether the user may send messages / mutate the thread workspace.
 */
export async function canWriteThread(userId: string, threadId: string): Promise<boolean> {
  const thread = await loadFullThread(threadId);
  if (!thread) return false;

  if (thread.userId === userId) return true;

  const link = await findThreadLink(threadId);
  if (!link || link.kind !== 'design_doc_assistant') return false;

  if (await isAdminUser(userId)) return true;
  return isAssignedApprover(link.documentId, 'design_doc', userId);
}

/**
 * Outcome of the Requirements-phase check for a single message send.
 * `not_applicable` means this thread has no open Requirements phase, so the
 * caller must fall back to the existing thread-write rules.
 */
export type RequirementsPhaseMessageWrite =
  | { outcome: 'not_applicable' }
  | { outcome: 'allowed'; thread: ChatThread }
  | { outcome: 'not_owner' }
  | { outcome: 'missing_manage_permission' }
  | { outcome: 'thread_not_found' };

export type TechnicalPhaseMessageWrite = RequirementsPhaseMessageWrite;

/** A configured Requirements phase that has not been approved yet. */
function requirementsPhaseIsOpen(row: {
  phaseFlow: string | null;
  requirementsPhaseStatus: string | null;
}): boolean {
  if (row.phaseFlow !== 'requirements_only' && row.phaseFlow !== 'both_sequential') {
    return false;
  }
  return row.requirementsPhaseStatus !== 'approved';
}

/**
 * Who may send a message into an interview thread while its Requirements phase
 * is still open (FEAT-004 / PBI-007 AC-0, AC-3).
 *
 * The assigned Requirements owner is the only writer, and reassignment can move
 * that owner away from the user who started the chat thread — so this decision
 * deliberately ignores thread ownership. It applies to the message-send route
 * only; technical-only flows, legacy interviews without phase fields, and
 * non-interview threads all report `not_applicable` and keep their existing
 * rules.
 */
export async function resolveRequirementsPhaseMessageWrite(
  userId: string,
  threadId: string,
): Promise<RequirementsPhaseMessageWrite> {
  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
    columns: {
      phaseFlow: true,
      requirementsOwnerId: true,
      requirementsPhaseStatus: true,
    },
  });
  if (!interview || !requirementsPhaseIsOpen(interview)) {
    return { outcome: 'not_applicable' };
  }

  if (interview.requirementsOwnerId !== userId) return { outcome: 'not_owner' };

  const perms = await getUserPermissions(userId);
  if (!perms.has('interviews:manage')) {
    return { outcome: 'missing_manage_permission' };
  }

  const thread = (await getThread(threadId)) ?? (await loadFullThread(threadId));
  if (!thread) return { outcome: 'thread_not_found' };
  return { outcome: 'allowed', thread };
}

/**
 * Dedicated Technical threads stay readable to project viewers, but only the
 * assigned Technical owner with interviews:manage may add messages.
 */
export async function resolveTechnicalPhaseMessageWrite(
  userId: string,
  threadId: string,
): Promise<TechnicalPhaseMessageWrite> {
  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.technicalPhaseChatThreadId, threadId),
    columns: {
      technicalOwnerId: true,
    },
  });
  if (!interview) return { outcome: 'not_applicable' };
  if (interview.technicalOwnerId !== userId) return { outcome: 'not_owner' };

  const perms = await getUserPermissions(userId);
  if (!perms.has('interviews:manage')) {
    return { outcome: 'missing_manage_permission' };
  }
  const thread = (await getThread(threadId)) ?? (await loadFullThread(threadId));
  if (!thread) return { outcome: 'thread_not_found' };
  return { outcome: 'allowed', thread };
}

/** Author, admin, or assigned approver may create / replace doc_assistant_thread_id on a design doc. */
export async function canCreateDesignDocAssistantThread(
  userId: string,
  designDocId: string,
): Promise<boolean> {
  const doc = await db.query.designDocs.findFirst({
    where: eq(designDocs.id, designDocId),
    columns: { authorId: true },
  });
  if (!doc) return false;
  if (doc.authorId === userId) return true;
  if (await isAdminUser(userId)) return true;
  return isAssignedApprover(designDocId, 'design_doc', userId);
}
