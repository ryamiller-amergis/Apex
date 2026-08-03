const TTL_MS = 30 * 60 * 1000;

/** Hard wall-clock limit for Apex fix overlays so they never spin indefinitely. */
export const APEX_FIX_TIMEOUT_MS = 5 * 60 * 1000;

export type ApexFixSessionScope =
  | 'prd-comments-bulk'
  | 'prd-validation'
  | 'prd-coverage'
  | 'design-doc-comments-bulk'
  | 'design-doc-validation';

interface ApexFixSessionRecord {
  scope: ApexFixSessionScope;
  documentId: string;
  startedAt: string;
  commentId?: string | null;
  threadId?: string | null;
}

/**
 * Chat thread statuses that mean an Apex fix run is finished (success or failure).
 * DB terminal values are idle | failed | cancelled; clients historically also used "error".
 * Anything that is not actively running/streaming is treated as done so overlays never stick.
 */
export function isTerminalChatThreadStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'running' || normalized === 'streaming') return false;
  return true;
}

/** Human-readable error when a terminal thread status indicates failure/cancel. */
export function agentErrorFromChatThreadStatus(
  status: string,
  lastError?: string,
): string | undefined {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'idle') return undefined;
  if (normalized === 'failed' || normalized === 'error') {
    return lastError ?? 'The AI agent encountered an error and could not complete the fix.';
  }
  if (normalized === 'cancelled') {
    return lastError ?? 'The fix was cancelled.';
  }
  // Unknown non-active status — treat as failed so the UI can recover
  if (isTerminalChatThreadStatus(status) && normalized !== 'idle') {
    return lastError ?? `The fix session ended unexpectedly (${status}). You can try again.`;
  }
  return undefined;
}

/** Best-effort abort of an in-flight chat agent run. */
export async function cancelChatThread(threadId: string): Promise<void> {
  try {
    await fetch(`/api/chat/threads/${threadId}/cancel`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    /* non-fatal */
  }
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
