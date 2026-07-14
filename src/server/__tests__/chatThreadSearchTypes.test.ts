import type {
  ChatThreadMatch,
  ChatThreadSearchResult,
} from '../../shared/types/chat';

const summary = {
  id: 'thread-1',
  userId: 'user-1',
  title: 'Notifications',
  status: 'idle' as const,
  kickoff: { project: 'Apex', repo: 'Apex' },
  flagged: false,
  createdAt: '2026-07-14T00:00:00.000Z',
  lastActivityAt: '2026-07-14T01:00:00.000Z',
};

describe('chat thread search result types', () => {
  it('DoD-0 supports a thread result with matched-message context', () => {
    const match: ChatThreadMatch = {
      messageId: 'message-1',
      role: 'agent',
      snippet: 'The notifications setting is available here.',
      matchedAt: '2026-07-14T00:30:00.000Z',
    };
    const result: ChatThreadSearchResult = { ...summary, match };

    expect(result.match).toEqual(match);
    expect(result.titleOnly).toBeUndefined();
  });

  it('DoD-0 supports a title-only thread result', () => {
    const result: ChatThreadSearchResult = {
      ...summary,
      titleOnly: true,
    };

    expect(result.titleOnly).toBe(true);
    expect(result.match).toBeUndefined();
  });

  it('DoD-2 exposes only owner-visible matched-message fields', () => {
    const match: ChatThreadMatch = {
      messageId: 'message-1',
      role: 'user',
      snippet: 'notification preferences',
      matchedAt: '2026-07-14T00:30:00.000Z',
    };

    expect(Object.keys(match).sort()).toEqual([
      'matchedAt',
      'messageId',
      'role',
      'snippet',
    ]);
  });
});
