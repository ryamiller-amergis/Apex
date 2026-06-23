const TTL_MS = 30 * 60 * 1000;

export type ApexFixSessionScope =
  | 'prd-comments-bulk'
  | 'prd-validation'
  | 'design-doc-comments-bulk'
  | 'design-doc-validation';

interface ApexFixSessionRecord {
  scope: ApexFixSessionScope;
  documentId: string;
  startedAt: string;
  commentId?: string | null;
  threadId?: string | null;
}

function storageKey(scope: ApexFixSessionScope, documentId: string): string {
  return `ai-pilot:apex-fix:${scope}:${documentId}`;
}

export function markApexFixInProgress(
  scope: ApexFixSessionScope,
  documentId: string,
  extras?: { commentId?: string | null; threadId?: string | null },
): void {
  try {
    const record: ApexFixSessionRecord = {
      scope,
      documentId,
      startedAt: new Date().toISOString(),
      commentId: extras?.commentId,
      threadId: extras?.threadId,
    };
    sessionStorage.setItem(storageKey(scope, documentId), JSON.stringify(record));
  } catch {
    /* non-fatal */
  }
}

export function clearApexFixInProgress(scope: ApexFixSessionScope, documentId: string): void {
  try {
    sessionStorage.removeItem(storageKey(scope, documentId));
  } catch {
    /* non-fatal */
  }
}

export function readApexFixInProgress(
  scope: ApexFixSessionScope,
  documentId: string,
): ApexFixSessionRecord | null {
  try {
    const raw = sessionStorage.getItem(storageKey(scope, documentId));
    if (!raw) return null;
    const record = JSON.parse(raw) as ApexFixSessionRecord;
    const age = Date.now() - new Date(record.startedAt).getTime();
    if (age > TTL_MS) {
      clearApexFixInProgress(scope, documentId);
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

export async function fetchChatThreadStatus(
  threadId: string,
): Promise<{ status: string; lastError?: string } | null> {
  try {
    const res = await fetch(`/api/chat/threads/${threadId}`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
