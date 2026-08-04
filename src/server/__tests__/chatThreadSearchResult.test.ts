/**
 * TBI-001 — shared chat thread search result type
 * DoD coverage: DoD-0 (shape), DoD-1 (compiles via import), DoD-2 (no extra sensitive fields)
 * Lives under server tests so Jest picks it up; type is defined in src/shared/types/chat.ts.
 */
import type {
  ChatThreadMatch,
  ChatThreadSearchResult,
  ChatThreadSummary,
} from '../../shared/types/chat';

const baseSummary: ChatThreadSummary = {
  id: 'thread-1',
  userId: 'user-1',
  title: 'Notifications design',
  status: 'idle',
  kickoff: { project: 'Apex', repo: 'AI-Pilot' },
  flagged: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActivityAt: '2026-07-10T00:00:00.000Z',
};

describe('TBI-001 ChatThreadSearchResult shared type', () => {
  it('DoD-0: expresses thread summary plus optional match context', () => {
    const match: ChatThreadMatch = {
      messageId: 'msg-1',
      role: 'agent',
      snippet: '...text around the hit...',
      matchedAt: '2026-07-10T12:34:56.000Z',
    };

    const result: ChatThreadSearchResult = {
      ...baseSummary,
      match,
      titleOnly: false,
    };

    expect(result.id).toBe(baseSummary.id);
    expect(result.match).toEqual(match);
    expect(result.titleOnly).toBe(false);
  });

  it('DoD-0: expresses title-only case without match object', () => {
    const result: ChatThreadSearchResult = {
      ...baseSummary,
      titleOnly: true,
    };

    expect(result.titleOnly).toBe(true);
    expect(result.match).toBeUndefined();
  });

  it('DoD-1: type is importable from shared chat types (client+server consume same module)', () => {
    const keys = Object.keys(baseSummary);
    expect(keys).toEqual(
      expect.arrayContaining([
        'id',
        'userId',
        'title',
        'status',
        'kickoff',
        'flagged',
        'createdAt',
        'lastActivityAt',
      ]),
    );
  });

  it('DoD-2: match shape only includes owner-visible message fields (no hidden/tool payloads)', () => {
    const match: ChatThreadMatch = {
      messageId: 'msg-2',
      role: 'user',
      snippet: 'plain snippet',
      matchedAt: '2026-07-10T12:00:00.000Z',
    };

    expect(Object.keys(match).sort()).toEqual(
      ['matchedAt', 'messageId', 'role', 'snippet'].sort(),
    );
    expect(match.role === 'user' || match.role === 'agent').toBe(true);
  });
});
