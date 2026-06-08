import { eq, or } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designDocs, interviews, prds } from '../db/schema';
import type { ChatThread } from '../../shared/types/chat';
import { loadFullThread } from './chatThreadRepository';
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
    where: eq(interviews.chatThreadId, threadId),
    columns: { id: true },
  });
  if (interview) return { kind: 'interview', documentId: interview.id };

  const prd = await db.query.prds.findFirst({
    where: eq(prds.chatThreadId, threadId),
    columns: { id: true },
  });
  if (prd) return { kind: 'prd', documentId: prd.id };

  const doc = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.qaChatThreadId, threadId),
      eq(designDocs.docAssistantThreadId, threadId),
      eq(designDocs.validationThreadId, threadId),
    ),
    columns: {
      id: true,
      chatThreadId: true,
      qaChatThreadId: true,
      docAssistantThreadId: true,
      validationThreadId: true,
    },
  });
  if (!doc) return null;

  if (doc.chatThreadId === threadId) return { kind: 'design_doc', documentId: doc.id };
  if (doc.qaChatThreadId === threadId) return { kind: 'design_doc_qa', documentId: doc.id };
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
  const thread = await loadFullThread(threadId);
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
