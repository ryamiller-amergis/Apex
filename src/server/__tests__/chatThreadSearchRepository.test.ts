import { db } from '../db/drizzle';
import {
  buildSearchSnippet,
  searchThreads,
} from '../services/chatThreadRepository';

jest.mock('../db/drizzle', () => ({
  db: {
    execute: jest.fn(),
  },
}));

const execute = db.execute as jest.Mock;

const baseRow = {
  id: 'thread-1',
  user_id: 'user-1',
  title: 'Notifications',
  status: 'idle',
  kickoff: { project: 'Apex', repo: 'Apex' },
  flagged: false,
  flagged_at: null,
  created_at: '2026-07-14T00:00:00.000Z',
  last_activity_at: '2026-07-14T01:00:00.000Z',
  first_user_message: 'How do notifications work?',
  message_id: 'message-1',
  message_role: 'agent',
  message_text: 'You can configure notifications from project settings.',
  matched_at: '2026-07-14T00:30:00.000Z',
  title_only: false,
};

function sqlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (!value || typeof value !== 'object') return '';
  const node = value as { queryChunks?: unknown[]; value?: unknown };
  if (node.queryChunks) return sqlText(node.queryChunks);
  if (
    Array.isArray(node.value) &&
    node.value.every((part) => typeof part === 'string')
  ) {
    return node.value.join('');
  }
  return '';
}

function sqlParams(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(sqlParams);
  if (!value || typeof value !== 'object')
    return value === undefined ? [] : [value];
  const node = value as {
    queryChunks?: unknown[];
    value?: unknown;
    constructor?: { name?: string };
  };
  if (node.constructor?.name === 'StringChunk') return [];
  if (node.constructor?.name === 'Param') return [node.value];
  return node.queryChunks?.flatMap(sqlParams) ?? [];
}

describe('searchThreads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execute.mockResolvedValue({ rows: [baseRow] });
  });

  it('DoD-0 returns one result with the most recent matching-message context', async () => {
    const results = await searchThreads('user-1', { term: 'notif' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: 'thread-1',
      userId: 'user-1',
      match: {
        messageId: 'message-1',
        role: 'agent',
        snippet: 'You can configure notifications from project settings.',
        matchedAt: '2026-07-14T00:30:00.000Z',
      },
    });
    expect(results[0].titleOnly).toBe(false);
  });

  it('DoD-1 and BR-002 constrain matches to visible user and agent messages', async () => {
    await searchThreads('user-1', { term: 'hidden-only-token' });

    const query = sqlText(execute.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(query).toContain("m.role IN ('user', 'agent')");
    expect(query).toContain('m.hidden = false');
  });

  it('DoD-2 preserves database recency order and marks title-only fallback rows', async () => {
    execute.mockResolvedValue({
      rows: [
        baseRow,
        {
          ...baseRow,
          id: 'thread-title',
          title: 'Notification planning',
          message_id: null,
          message_role: null,
          message_text: null,
          matched_at: null,
          title_only: true,
        },
      ],
    });

    const results = await searchThreads('user-1', { term: 'notif' });
    const query = sqlText(execute.mock.calls[0][0]).replace(/\s+/g, ' ');

    expect(results.map((result) => result.id)).toEqual([
      'thread-1',
      'thread-title',
    ]);
    expect(results[1]).toMatchObject({ titleOnly: true });
    expect(results[1].match).toBeUndefined();
    expect(query).toContain('ORDER BY m.thread_id, m.ts DESC, m.id DESC');
    expect(query).toContain(
      'ORDER BY COALESCE(mm.matched_at, et.last_activity_at) DESC, et.id DESC'
    );
  });

  it('DoD-3 applies flagged-only and project filters in the scoped query', async () => {
    await searchThreads('user-1', {
      term: 'design',
      flaggedOnly: true,
      project: 'Apex',
    });

    const query = sqlText(execute.mock.calls[0][0]).replace(/\s+/g, ' ');
    const params = sqlParams(execute.mock.calls[0][0]);
    expect(query).toContain('t.flagged = true');
    expect(query).toContain("t.kickoff->>'project'");
    expect(params).toEqual(
      expect.arrayContaining(['user-1', 'Apex', '%design%'])
    );
  });

  it('DoD-4 and AC-3 hard-scope the query to the caller and return no foreign rows', async () => {
    execute.mockResolvedValue({ rows: [] });

    await expect(
      searchThreads('user-1', { term: 'foreign-secret' })
    ).resolves.toEqual([]);

    const query = sqlText(execute.mock.calls[0][0]).replace(/\s+/g, ' ');
    const params = sqlParams(execute.mock.calls[0][0]);
    expect(query).toContain('t.user_id =');
    expect(params).toContain('user-1');
  });

  it('BR-003 matches by case-insensitive substring on title and message text', async () => {
    await searchThreads('user-1', { term: 'NoTiF' });

    const query = sqlText(execute.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(query).toContain('m.text ILIKE');
    expect(query).toContain('et.title ILIKE');
    expect(query).toContain("ESCAPE '!'");
    expect(sqlParams(execute.mock.calls[0][0])).toContain('%NoTiF%');
  });

  it('BR-003 treats SQL wildcard characters as plain search text', async () => {
    await searchThreads('user-1', { term: '50%_done!' });

    expect(sqlParams(execute.mock.calls[0][0])).toContain('%50!%!_done!!%');
  });
});

describe('buildSearchSnippet', () => {
  it('BR-005 returns a plain approximately 120-character excerpt around the first hit', () => {
    const text = `${'a'.repeat(100)}notifications${'b'.repeat(100)}`;
    const snippet = buildSearchSnippet(text, 'notif');

    expect(snippet).toContain('notifications');
    expect(snippet.length).toBeLessThanOrEqual(122);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });
});
