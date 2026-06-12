import {
  clearApexFixInProgress,
  fetchChatThreadStatus,
  markApexFixInProgress,
  readApexFixInProgress,
} from '../apexFixSession';

describe('apexFixSession', () => {
  beforeEach(() => {
    sessionStorage.clear();
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T12:00:00Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('stores and reads Apex fix session metadata', () => {
    markApexFixInProgress('prd-validation', 'prd-1', {
      commentId: 'comment-1',
      threadId: 'thread-1',
    });

    expect(readApexFixInProgress('prd-validation', 'prd-1')).toEqual({
      scope: 'prd-validation',
      documentId: 'prd-1',
      startedAt: '2026-01-01T12:00:00.000Z',
      commentId: 'comment-1',
      threadId: 'thread-1',
    });
  });

  it('clears an in-progress marker', () => {
    markApexFixInProgress('design-doc-validation', 'doc-1');

    clearApexFixInProgress('design-doc-validation', 'doc-1');

    expect(readApexFixInProgress('design-doc-validation', 'doc-1')).toBeNull();
  });

  it('expires stale Apex fix markers after the TTL', () => {
    sessionStorage.setItem(
      'ai-pilot:apex-fix:prd-comments-bulk:prd-1',
      JSON.stringify({
        scope: 'prd-comments-bulk',
        documentId: 'prd-1',
        startedAt: '2026-01-01T11:29:59.000Z',
      }),
    );

    expect(readApexFixInProgress('prd-comments-bulk', 'prd-1')).toBeNull();
    expect(sessionStorage.getItem('ai-pilot:apex-fix:prd-comments-bulk:prd-1')).toBeNull();
  });

  it('returns chat thread status when the API succeeds', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'running' }),
    }) as jest.Mock;

    await expect(fetchChatThreadStatus('thread-1')).resolves.toEqual({ status: 'running' });
    expect(global.fetch).toHaveBeenCalledWith('/api/chat/threads/thread-1', {
      credentials: 'include',
    });
  });

  it('returns null for chat thread status errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as jest.Mock;

    await expect(fetchChatThreadStatus('thread-1')).resolves.toBeNull();
  });
});
