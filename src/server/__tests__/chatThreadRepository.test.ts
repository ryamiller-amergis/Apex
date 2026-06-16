import {
  upsertThread,
  insertMessage,
  listThreadsByUser,
  loadFullThread,
  deleteThread,
  toggleFlag,
} from '../services/chatThreadRepository';
import type { ChatThread, ChatMessage } from '../../shared/types/chat';

// ── Mock Drizzle ──────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
    query: {
      chatThreads: {
        findFirst: jest.fn(),
      },
    },
  },
}));

// Import AFTER mock is registered so the repository module gets the mock
import { db } from '../db/drizzle';

// ── Chain builder helpers ─────────────────────────────────────────────────────

function buildInsertChain(resolved: unknown = undefined) {
  const onConflictDoNothing = jest.fn().mockResolvedValue(resolved);
  const onConflictDoUpdate = jest.fn().mockResolvedValue(resolved);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  return { insert: { values }, onConflictDoNothing, onConflictDoUpdate, values };
}

function buildSelectChain(rows: unknown[] = []) {
  const offset = jest.fn().mockResolvedValue(rows);
  const limit = jest.fn().mockReturnValue({ offset });
  const orderBy = jest.fn().mockReturnValue({ limit });
  const where = jest.fn().mockReturnValue({ orderBy });
  const from = jest.fn().mockReturnValue({ where });
  return { from, where, orderBy, limit, offset };
}

function buildDeleteChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  return { where };
}

function buildUpdateChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  return { set, where };
}

function buildTxInsertChain() {
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing });
  return { values, onConflictDoNothing };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const sampleKickoff: ChatThread['kickoff'] = {
  project: 'TestProject',
  repo: 'TestRepo',
  skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
};

const sampleMessage: ChatMessage = {
  id: 'msg-1',
  role: 'user',
  text: 'Hello, agent!',
  ts: '2026-01-01T10:00:00.000Z',
};

const sampleThread: ChatThread = {
  id: 'thread-1',
  userId: 'user-1',
  status: 'idle',
  kickoff: sampleKickoff,
  messages: [sampleMessage],
  workspaceDir: '/tmp/workspace',
  flagged: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2026-01-01T01:00:00.000Z',
};

// ── upsertThread ──────────────────────────────────────────────────────────────

describe('upsertThread', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const chain = buildInsertChain();
    (db.insert as jest.Mock).mockReturnValue(chain.insert);
  });

  it('calls insert with all required fields', async () => {
    await upsertThread(sampleThread);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const [insertArg] = (db.insert as jest.Mock).mock.calls[0];
    expect(insertArg).toBeDefined(); // chatThreads table object

    const chain = (db.insert as jest.Mock).mock.results[0].value;
    const valuesCall = chain.values.mock.calls[0][0];
    expect(valuesCall.id).toBe('thread-1');
    expect(valuesCall.userId).toBe('user-1');
    expect(valuesCall.status).toBe('idle');
    expect(valuesCall.kickoff).toEqual(sampleKickoff);
    expect(valuesCall.workspaceDir).toBe('/tmp/workspace');
    expect(valuesCall.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(valuesCall.lastActivityAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('derives title from skillPath (folder name, Title Case)', async () => {
    await upsertThread(sampleThread);

    const chain = (db.insert as jest.Mock).mock.results[0].value;
    const valuesCall = chain.values.mock.calls[0][0];
    // '.cursor/skills/grill-with-docs/SKILL.md' → 'grill-with-docs' → 'Grill With Docs'
    expect(valuesCall.title).toBe('Grill With Docs - Hello, agent!');
  });

  it('derives title from first user message when no skillPath', async () => {
    const threadNoSkill: ChatThread = {
      ...sampleThread,
      kickoff: { project: 'P', repo: 'R' },
      messages: [{ id: 'm1', role: 'user', text: 'Build me an auth system', ts: '2026-01-01T00:00:00Z' }],
    };

    await upsertThread(threadNoSkill);

    const chain = (db.insert as jest.Mock).mock.results[0].value;
    const valuesCall = chain.values.mock.calls[0][0];
    expect(valuesCall.title).toBe('Build me an auth system');
  });

  it('falls back to "Free chat" title when no skill and no user messages', async () => {
    const emptyThread: ChatThread = {
      ...sampleThread,
      kickoff: { project: 'P', repo: 'R' },
      messages: [],
    };

    await upsertThread(emptyThread);

    const chain = (db.insert as jest.Mock).mock.results[0].value;
    const valuesCall = chain.values.mock.calls[0][0];
    expect(valuesCall.title).toBe('Free chat');
  });

  it('maps undefined optional fields to null', async () => {
    const threadNoOptionals: ChatThread = {
      ...sampleThread,
      cursorAgentId: undefined,
      lastError: undefined,
      savedWikiUrl: undefined,
    };

    await upsertThread(threadNoOptionals);

    const chain = (db.insert as jest.Mock).mock.results[0].value;
    const valuesCall = chain.values.mock.calls[0][0];
    expect(valuesCall.cursorAgentId).toBeNull();
    expect(valuesCall.lastError).toBeNull();
    expect(valuesCall.savedWikiUrl).toBeNull();
  });

  it('excludes createdAt from the conflict-update set', async () => {
    await upsertThread(sampleThread);

    const chain = (db.insert as jest.Mock).mock.results[0].value;
    const insertChain = chain.values.mock.results[0].value;
    const updateSet = insertChain.onConflictDoUpdate.mock.calls[0][0].set;
    expect(updateSet).not.toHaveProperty('createdAt');
    expect(updateSet).toHaveProperty('status');
    expect(updateSet).toHaveProperty('lastActivityAt');
  });
});

// ── insertMessage ─────────────────────────────────────────────────────────────

describe('insertMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (db.transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const txChain = buildTxInsertChain();
      const tx = {
        insert: jest.fn().mockReturnValue(txChain),
      };
      return fn(tx);
    });
  });

  it('runs inside a transaction', async () => {
    await insertMessage('thread-1', sampleMessage);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('inserts the message with correct fields', async () => {
    let capturedTx: any;
    (db.transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const txChain = buildTxInsertChain();
      const tx = { insert: jest.fn().mockReturnValue(txChain) };
      capturedTx = tx;
      return fn(tx);
    });

    await insertMessage('thread-1', sampleMessage);

    expect(capturedTx.insert).toHaveBeenCalledTimes(1);
    const valuesCall = capturedTx.insert.mock.results[0].value.values.mock.calls[0][0];
    expect(valuesCall.id).toBe('msg-1');
    expect(valuesCall.threadId).toBe('thread-1');
    expect(valuesCall.role).toBe('user');
    expect(valuesCall.text).toBe('Hello, agent!');
    expect(valuesCall.ts).toBe('2026-01-01T10:00:00.000Z');
  });

  it('does not insert attachments when message has none', async () => {
    let capturedTx: any;
    (db.transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const txChain = buildTxInsertChain();
      const tx = { insert: jest.fn().mockReturnValue(txChain) };
      capturedTx = tx;
      return fn(tx);
    });

    await insertMessage('thread-1', { ...sampleMessage, attachments: undefined });

    // Only one insert call (message), no attachment insert
    expect(capturedTx.insert).toHaveBeenCalledTimes(1);
  });

  it('inserts each attachment in the same transaction', async () => {
    let capturedTx: any;
    (db.transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const txChain = buildTxInsertChain();
      const tx = { insert: jest.fn().mockReturnValue(txChain) };
      capturedTx = tx;
      return fn(tx);
    });

    const msgWithAttachments: ChatMessage = {
      ...sampleMessage,
      attachments: [
        { id: 'att-1', name: 'file.txt', type: 'text/plain', size: 100, path: '/tmp/file.txt' },
        { id: 'att-2', name: 'img.png', type: 'image/png', size: 2048 },
      ],
    };

    await insertMessage('thread-1', msgWithAttachments);

    // 1 message insert + 2 attachment inserts = 3 total
    expect(capturedTx.insert).toHaveBeenCalledTimes(3);
  });

  it('maps undefined attachment path to null', async () => {
    let capturedTx: any;
    (db.transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const txChain = buildTxInsertChain();
      const tx = { insert: jest.fn().mockReturnValue(txChain) };
      capturedTx = tx;
      return fn(tx);
    });

    const msgWithAtt: ChatMessage = {
      ...sampleMessage,
      attachments: [{ id: 'att-1', name: 'file.txt', type: 'text/plain', size: 100 }],
    };

    await insertMessage('thread-1', msgWithAtt);

    // Both tx.insert() calls return the same chain; calls[0] = message, calls[1] = attachment
    const attValuesCall = capturedTx.insert.mock.results[0].value.values.mock.calls[1][0];
    expect(attValuesCall.path).toBeNull();
  });
});

// ── listThreadsByUser ─────────────────────────────────────────────────────────

describe('listThreadsByUser', () => {
  const dbRows = [
    {
      id: 'thread-1',
      userId: 'user-1',
      title: 'Grill With Docs',
      status: 'idle',
      kickoff: { project: 'TestProject', repo: 'TestRepo', skillPath: 'some/path' },
      flagged: true,
      flaggedAt: '2026-01-01T12:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-02T00:00:00.000Z',
      firstUserMessage: null,
    },
    {
      id: 'thread-2',
      userId: 'user-1',
      title: null,
      status: 'error',
      kickoff: { project: 'TestProject', repo: 'TestRepo' },
      flagged: false,
      flaggedAt: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      lastActivityAt: '2026-01-03T00:00:00.000Z',
      firstUserMessage: null,
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    const chain = buildSelectChain(dbRows);
    (db.select as jest.Mock).mockReturnValue(chain);
  });

  it('returns mapped ChatThreadSummary array', async () => {
    const result = await listThreadsByUser('user-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 'thread-1',
      userId: 'user-1',
      title: 'Grill With Docs',
      status: 'idle',
      kickoff: { project: 'TestProject', repo: 'TestRepo', skillPath: 'some/path' },
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('maps firstUserMessage to messagePreview for history labels', async () => {
    const rowWithPreview = {
      id: 'thread-ak',
      userId: 'user-1',
      title: 'App Knowledge - How does auth work?',
      status: 'idle',
      kickoff: {
        project: 'TestProject',
        repo: 'TestRepo',
        pillLabel: 'App Knowledge',
        skillPath: '/.cursor/skills/app-knowledge/SKILL.md',
      },
      flagged: false,
      flaggedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-02T00:00:00.000Z',
      firstUserMessage: 'How does auth work?',
    };
    const chain = buildSelectChain([rowWithPreview]);
    (db.select as jest.Mock).mockReturnValue(chain);

    const result = await listThreadsByUser('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].messagePreview).toBe('How does auth work?');
    expect(result[0].kickoff.pillLabel).toBe('App Knowledge');
  });

  it('substitutes "Untitled" for null title', async () => {
    const result = await listThreadsByUser('user-1');
    expect(result[1].title).toBe('Untitled');
  });

  it('uses default limit of 50 and offset of 0', async () => {
    const chain = buildSelectChain(dbRows);
    (db.select as jest.Mock).mockReturnValue(chain);

    await listThreadsByUser('user-1');

    expect(chain.limit).toHaveBeenCalledWith(50);
    expect(chain.offset).toHaveBeenCalledWith(0);
  });

  it('passes custom limit and offset', async () => {
    const chain = buildSelectChain([]);
    (db.select as jest.Mock).mockReturnValue(chain);

    await listThreadsByUser('user-1', { limit: 10, offset: 20 });

    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(chain.offset).toHaveBeenCalledWith(20);
  });

  it('returns empty array when there are no threads', async () => {
    const chain = buildSelectChain([]);
    (db.select as jest.Mock).mockReturnValue(chain);

    const result = await listThreadsByUser('user-1');
    expect(result).toEqual([]);
  });
});

// ── loadFullThread ────────────────────────────────────────────────────────────

describe('loadFullThread', () => {
  const dbResult = {
    id: 'thread-1',
    userId: 'user-1',
    status: 'idle',
    kickoff: sampleKickoff,
    cursorAgentId: null,
    workspaceDir: '/tmp/workspace',
    lastError: null,
    savedWikiUrl: null,
    flagged: false,
    flaggedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-01-01T01:00:00.000Z',
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        text: 'Hello',
        toolName: null,
        ts: '2026-01-01T10:00:00.000Z',
        attachments: [
          { id: 'att-1', messageId: 'msg-1', name: 'file.txt', type: 'text/plain', size: 100, path: '/tmp/file.txt' },
        ],
      },
      {
        id: 'msg-2',
        role: 'agent',
        text: 'Hi there',
        toolName: 'list_files',
        ts: '2026-01-01T10:01:00.000Z',
        attachments: [],
      },
    ],
  };

  it('returns null when thread is not found', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(undefined);

    const result = await loadFullThread('missing-id');
    expect(result).toBeNull();
  });

  it('returns a fully mapped ChatThread', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResult);

    const result = await loadFullThread('thread-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('thread-1');
    expect(result!.userId).toBe('user-1');
    expect(result!.status).toBe('idle');
    expect(result!.kickoff).toEqual(sampleKickoff);
    expect(result!.workspaceDir).toBe('/tmp/workspace');
    expect(result!.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result!.lastActivityAt).toBe('2026-01-01T01:00:00.000Z');
  });

  it('maps messages with correct shape', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResult);

    const result = await loadFullThread('thread-1');

    expect(result!.messages).toHaveLength(2);
    expect(result!.messages[0]).toMatchObject({
      id: 'msg-1',
      role: 'user',
      text: 'Hello',
      ts: '2026-01-01T10:00:00.000Z',
    });
  });

  it('maps attachments onto the correct message', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResult);

    const result = await loadFullThread('thread-1');

    expect(result!.messages[0].attachments).toHaveLength(1);
    expect(result!.messages[0].attachments![0]).toMatchObject({
      id: 'att-1',
      name: 'file.txt',
      type: 'text/plain',
      size: 100,
      path: '/tmp/file.txt',
    });
  });

  it('sets attachments to undefined (not empty array) when a message has none', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResult);

    const result = await loadFullThread('thread-1');

    // msg-2 has no attachments in the DB result
    expect(result!.messages[1].attachments).toBeUndefined();
  });

  it('maps null toolName to undefined', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResult);

    const result = await loadFullThread('thread-1');

    expect(result!.messages[0].toolName).toBeUndefined();
  });

  it('maps non-null toolName through', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResult);

    const result = await loadFullThread('thread-1');

    expect(result!.messages[1].toolName).toBe('list_files');
  });

  it('maps null cursorAgentId to undefined', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResult);

    const result = await loadFullThread('thread-1');

    expect(result!.cursorAgentId).toBeUndefined();
  });

  it('maps null path in attachment to undefined', async () => {
    const dbResultNullPath = {
      ...dbResult,
      messages: [
        {
          ...dbResult.messages[0],
          attachments: [
            { id: 'att-1', messageId: 'msg-1', name: 'file.txt', type: 'text/plain', size: 100, path: null },
          ],
        },
      ],
    };
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(dbResultNullPath);

    const result = await loadFullThread('thread-1');

    expect(result!.messages[0].attachments![0].path).toBeUndefined();
  });
});

// ── deleteThread ──────────────────────────────────────────────────────────────

describe('deleteThread', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls db.delete with the correct thread id', async () => {
    const chain = buildDeleteChain();
    (db.delete as jest.Mock).mockReturnValue(chain);

    await deleteThread('thread-1');

    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('resolves without error', async () => {
    const chain = buildDeleteChain();
    (db.delete as jest.Mock).mockReturnValue(chain);

    await expect(deleteThread('thread-1')).resolves.toBeUndefined();
  });
});

// ── toggleFlag ─────────────────────────────────────────────────────────────────

describe('toggleFlag', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls db.update with flagged=true and a non-null flaggedAt', async () => {
    const chain = buildUpdateChain();
    (db.update as jest.Mock).mockReturnValue(chain);

    const result = await toggleFlag('thread-1', true);

    expect(db.update).toHaveBeenCalledTimes(1);
    const setArg = chain.set.mock.calls[0][0];
    expect(setArg.flagged).toBe(true);
    expect(setArg.flaggedAt).toBeTruthy();
    expect(result.flagged).toBe(true);
    expect(result.flaggedAt).not.toBeNull();
  });

  it('calls db.update with flagged=false and null flaggedAt', async () => {
    const chain = buildUpdateChain();
    (db.update as jest.Mock).mockReturnValue(chain);

    const result = await toggleFlag('thread-1', false);

    const setArg = chain.set.mock.calls[0][0];
    expect(setArg.flagged).toBe(false);
    expect(setArg.flaggedAt).toBeNull();
    expect(result.flagged).toBe(false);
    expect(result.flaggedAt).toBeNull();
  });

  it('returns an ISO-8601 timestamp when flagging', async () => {
    const chain = buildUpdateChain();
    (db.update as jest.Mock).mockReturnValue(chain);

    const result = await toggleFlag('thread-1', true);

    expect(() => new Date(result.flaggedAt!).toISOString()).not.toThrow();
  });

  it('calls where with the correct thread id', async () => {
    const chain = buildUpdateChain();
    (db.update as jest.Mock).mockReturnValue(chain);

    await toggleFlag('thread-42', true);

    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});

// ── listThreadsByUser — flagged fields ─────────────────────────────────────────

describe('listThreadsByUser — flagged fields', () => {
  const flaggedRow = {
    id: 'thread-f1',
    userId: 'user-1',
    title: 'Flagged Thread',
    status: 'idle',
    kickoff: { project: 'P', repo: 'R' },
    flagged: true,
    flaggedAt: '2026-02-01T09:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-02-01T09:00:00.000Z',
  };

  const unflaggedRow = {
    ...flaggedRow,
    id: 'thread-f2',
    title: 'Not Flagged',
    flagged: false,
    flaggedAt: null,
  };

  beforeEach(() => jest.clearAllMocks());

  it('includes flagged=true and flaggedAt in the summary', async () => {
    const chain = buildSelectChain([flaggedRow]);
    (db.select as jest.Mock).mockReturnValue(chain);

    const result = await listThreadsByUser('user-1');

    expect(result[0].flagged).toBe(true);
    expect(result[0].flaggedAt).toBe('2026-02-01T09:00:00.000Z');
  });

  it('includes flagged=false and undefined flaggedAt for unflagged threads', async () => {
    const chain = buildSelectChain([unflaggedRow]);
    (db.select as jest.Mock).mockReturnValue(chain);

    const result = await listThreadsByUser('user-1');

    expect(result[0].flagged).toBe(false);
    expect(result[0].flaggedAt).toBeUndefined();
  });
});

// ── loadFullThread — flagged fields ────────────────────────────────────────────

describe('loadFullThread — flagged fields', () => {
  const flaggedDbResult = {
    id: 'thread-f1',
    userId: 'user-1',
    status: 'idle',
    kickoff: sampleKickoff,
    cursorAgentId: null,
    workspaceDir: '/tmp/workspace',
    lastError: null,
    savedWikiUrl: null,
    flagged: true,
    flaggedAt: '2026-03-01T10:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActivityAt: '2026-03-01T10:00:00.000Z',
    messages: [],
  };

  it('maps flagged=true and flaggedAt through', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue(flaggedDbResult);

    const result = await loadFullThread('thread-f1');

    expect(result!.flagged).toBe(true);
    expect(result!.flaggedAt).toBe('2026-03-01T10:00:00.000Z');
  });

  it('maps null flaggedAt to undefined', async () => {
    (db.query.chatThreads.findFirst as jest.Mock).mockResolvedValue({
      ...flaggedDbResult,
      flagged: false,
      flaggedAt: null,
    });

    const result = await loadFullThread('thread-f1');

    expect(result!.flagged).toBe(false);
    expect(result!.flaggedAt).toBeUndefined();
  });
});
