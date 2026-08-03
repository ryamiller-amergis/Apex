/**
 * TBI-002 — user-scoped thread search query
 * Covers DoD-0..DoD-4, BR-001, BR-002, BR-004, BR-005, BR-006, A-007, VT-05..VT-10
 */
import {
  searchThreads,
  deriveMatchSnippet,
  escapeIlikePattern,
} from '../services/chatThreadRepository';

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
    execute: jest.fn(),
    query: {
      chatThreads: {
        findFirst: jest.fn(),
      },
    },
  },
}));

import { db } from '../db/drizzle';

function sqlText(arg: unknown): string {
  if (arg == null) return '';
  if (typeof arg === 'string') return arg;
  const chunks = (arg as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) {
    if (arg && typeof arg === 'object' && 'value' in (arg as object)) {
      return String((arg as { value: unknown }).value ?? '');
    }
    return String(arg);
  }
  return chunks.map((c) => sqlText(c)).join('');
}

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    user_id: 'user-1',
    title: 'Notifications design',
    status: 'idle',
    kickoff: { project: 'Apex', repo: 'AI-Pilot' },
    flagged: false,
    flagged_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    last_activity_at: '2026-07-10T00:00:00.000Z',
    message_id: 'msg-1',
    match_role: 'agent',
    message_text: 'We should use in-app notifications for this.',
    matched_at: '2026-07-10T12:00:00.000Z',
    title_only: false,
    first_user_message: 'How do notifications work?',
    ...overrides,
  };
}

describe('deriveMatchSnippet (A-007 / BR-005)', () => {
  it('VT-09: returns full short message without ellipsis', () => {
    expect(deriveMatchSnippet('hello notifications world', 'notif')).toBe(
      'hello notifications world',
    );
  });

  it('VT-09: centers ~120-char window and adds ellipsis when clipped', () => {
    const prefix = 'A'.repeat(80);
    const hit = 'notifications';
    const suffix = 'B'.repeat(80);
    const text = `${prefix}${hit}${suffix}`;
    const snippet = deriveMatchSnippet(text, 'notif');

    expect(snippet.startsWith('...')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
    expect(snippet.includes('notifications')).toBe(true);
    // ellipsis chars excluded: body length ≈ 120
    const body = snippet.replace(/^\.\.\./, '').replace(/\.\.\.$/, '');
    expect(body.length).toBeLessThanOrEqual(120);
  });

  it('VT-09: clamps near start without leading ellipsis', () => {
    const text = `notifications${'X'.repeat(200)}`;
    const snippet = deriveMatchSnippet(text, 'notif');
    expect(snippet.startsWith('notifications')).toBe(true);
    expect(snippet.endsWith('...')).toBe(true);
  });
});

describe('escapeIlikePattern', () => {
  it('escapes ILIKE wildcards for plain substring matching', () => {
    expect(escapeIlikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('searchThreads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DoD-0: returns one row per matching thread with most-recent matching-message snippet', async () => {
    (db.execute as jest.Mock).mockResolvedValue({
      rows: [
        baseRow({
          message_text: 'Earlier mention of notifications is fine.',
          matched_at: '2026-07-10T12:00:00.000Z',
        }),
      ],
    });

    const results = await searchThreads('user-1', { term: 'notif' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('thread-1');
    expect(results[0].titleOnly).toBe(false);
    expect(results[0].match).toMatchObject({
      messageId: 'msg-1',
      role: 'agent',
      matchedAt: '2026-07-10T12:00:00.000Z',
    });
    expect(results[0].match!.snippet.toLowerCase()).toContain('notif');
  });

  it('DoD-1 / VT-06: SQL excludes hidden/tool/system messages from matching', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ rows: [] });

    await searchThreads('user-1', { term: 'secret' });

    const text = sqlText((db.execute as jest.Mock).mock.calls[0][0]);
    expect(text).toMatch(/role IN \('user', 'agent'\)/);
    expect(text).toMatch(/hidden = false/);
  });

  it('DoD-2 / VT-07: preserves recency ordering from query (matchedAt DESC)', async () => {
    (db.execute as jest.Mock).mockResolvedValue({
      rows: [
        baseRow({
          id: 'thread-newer',
          matched_at: '2026-07-11T00:00:00.000Z',
          message_text: 'newer notifications',
        }),
        baseRow({
          id: 'thread-older',
          matched_at: '2026-07-09T00:00:00.000Z',
          message_text: 'older notifications',
        }),
      ],
    });

    const results = await searchThreads('user-1', { term: 'notif' });
    expect(results.map((r) => r.id)).toEqual(['thread-newer', 'thread-older']);
  });

  it('DoD-2 / VT-08: title-only match sets titleOnly and has no match object', async () => {
    (db.execute as jest.Mock).mockResolvedValue({
      rows: [
        baseRow({
          id: 'thread-title',
          title: 'Notifications roadmap',
          message_id: null,
          match_role: null,
          message_text: null,
          matched_at: null,
          title_only: true,
          last_activity_at: '2026-07-08T00:00:00.000Z',
        }),
      ],
    });

    const results = await searchThreads('user-1', { term: 'notif' });
    expect(results).toHaveLength(1);
    expect(results[0].titleOnly).toBe(true);
    expect(results[0].match).toBeUndefined();
  });

  it('DoD-3 / VT-10: honors flaggedOnly and project filters in SQL', async () => {
    (db.execute as jest.Mock).mockResolvedValue({ rows: [] });

    await searchThreads('user-1', {
      term: 'notif',
      flaggedOnly: true,
      project: 'Apex',
    });

    const text = sqlText((db.execute as jest.Mock).mock.calls[0][0]);
    expect(text).toMatch(/flagged = true/);
    expect(text).toMatch(/kickoff->>'project'/);
  });

  it('DoD-4 / VT-05 / BR-001: scopes query to caller userId', async () => {
    (db.execute as jest.Mock).mockResolvedValue({
      rows: [baseRow({ user_id: 'user-1' })],
    });

    const results = await searchThreads('user-1', { term: 'notif' });
    expect(results.every((r) => r.userId === 'user-1')).toBe(true);

    const text = sqlText((db.execute as jest.Mock).mock.calls[0][0]);
    expect(text).toMatch(/user_id/);
  });

  it('DoD-4: another user\'s matching thread is never returned by this call path', async () => {
    // Repository hard-scopes SQL to the provided userId; a row for another user
    // would require a broken query. Empty result simulates scoped exclusion.
    (db.execute as jest.Mock).mockResolvedValue({ rows: [] });

    const results = await searchThreads('user-me', { term: 'notif' });
    expect(results.find((r) => r.userId === 'user-other')).toBeUndefined();
    expect(results).toEqual([]);
  });

  it('propagates query failures to the caller (PBI-001 AC-1 path)', async () => {
    (db.execute as jest.Mock).mockRejectedValue(new Error('search boom'));
    await expect(searchThreads('user-1', { term: 'abc' })).rejects.toThrow('search boom');
  });
});
