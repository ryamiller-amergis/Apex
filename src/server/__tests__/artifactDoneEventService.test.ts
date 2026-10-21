/**
 * Unit tests for artifactDoneEventService (FEAT-001 / TBI-002).
 *
 * The Drizzle `db` instance is mocked. `db.insert` is backed by a small in-memory
 * store that honours `onConflictDoNothing` the way the unique constraint on
 * (artifact_type, artifact_id) does, so the tests can prove a second transition
 * cannot move a done timestamp that was already captured.
 */

jest.mock('../db/drizzle', () => ({
  db: {
    query: { artifactDoneEvents: { findFirst: jest.fn() } },
    insert: jest.fn(),
    update: jest.fn(),
  },
}));

import {
  recordArtifactDoneEvent,
  getArtifactDoneEventAt,
} from '../services/artifactDoneEventService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

type StoredEvent = { artifactType: string; artifactId: string; doneAt: string };

const store = new Map<string, StoredEvent>();
const keyOf = (row: StoredEvent) => `${row.artifactType}:${row.artifactId}`;

/** Mirrors an INSERT ... ON CONFLICT (artifact_type, artifact_id) against the real table. */
function fakeInsertChain() {
  let pending: StoredEvent | null = null;
  const chain: any = {
    values: jest.fn((row: StoredEvent) => {
      pending = row;
      return chain;
    }),
    onConflictDoNothing: jest.fn(async () => {
      if (!pending) return;
      const key = keyOf(pending);
      if (!store.has(key)) store.set(key, pending);
    }),
    // Present only so a service that reached for it would visibly overwrite the
    // first timestamp and fail the VT-21 assertion below.
    onConflictDoUpdate: jest.fn(async () => {
      if (!pending) return;
      store.set(keyOf(pending), pending);
    }),
    returning: jest.fn().mockResolvedValue([]),
  };
  return chain;
}

describe('artifactDoneEventService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    store.clear();
    mockDb.insert.mockImplementation(fakeInsertChain);
    mockDb.update.mockImplementation(() => {
      throw new Error('artifactDoneEventService must never UPDATE a captured done event');
    });
  });

  it('TBI-002 DoD-2 captures the transition timestamp as the done event', async () => {
    await recordArtifactDoneEvent('interview', 'int-1', '2026-08-10T12:00:00.000Z');

    expect(store.get('interview:int-1')).toEqual({
      artifactType: 'interview',
      artifactId: 'int-1',
      doneAt: '2026-08-10T12:00:00.000Z',
    });
  });

  it('TBI-002 DoD-2 writes insert-once so a re-approval cannot overwrite the first event', async () => {
    await recordArtifactDoneEvent('prd', 'prd-1', '2026-08-10T12:00:00.000Z');
    const chain = mockDb.insert.mock.results[0].value;

    expect(chain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(chain.onConflictDoUpdate).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('VT-21 a completed artifact edited after its done transition retains the first timestamp', async () => {
    await recordArtifactDoneEvent('interview', 'int-1', '2026-08-10T12:00:00.000Z');

    // A later edit + a second Mark Complete transition on the same interview.
    await recordArtifactDoneEvent('interview', 'int-1', '2026-08-20T09:30:00.000Z');

    expect(store.get('interview:int-1')?.doneAt).toBe('2026-08-10T12:00:00.000Z');
    expect(store.size).toBe(1);
  });

  it('VT-21 keeps a separate frozen event per artifact type for the same artifact id', async () => {
    await recordArtifactDoneEvent('prd', 'shared-id', '2026-08-01T00:00:00.000Z');
    await recordArtifactDoneEvent('test_case', 'shared-id', '2026-08-05T00:00:00.000Z');

    expect(store.get('prd:shared-id')?.doneAt).toBe('2026-08-01T00:00:00.000Z');
    expect(store.get('test_case:shared-id')?.doneAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('TBI-002 DoD-2 defaults the done timestamp to the moment of the call', async () => {
    const before = Date.now();
    await recordArtifactDoneEvent('design_doc', 'doc-1');
    const after = Date.now();

    const recorded = store.get('design_doc:doc-1')?.doneAt;
    expect(recorded).toBeDefined();
    const recordedMs = Date.parse(recorded as string);
    expect(recordedMs).toBeGreaterThanOrEqual(before);
    expect(recordedMs).toBeLessThanOrEqual(after);
  });

  it('TBI-002 DoD-2 reads back the frozen done timestamp', async () => {
    mockDb.query.artifactDoneEvents.findFirst.mockResolvedValue({
      doneAt: '2026-08-10T12:00:00.000Z',
    });

    await expect(getArtifactDoneEventAt('design_prototype', 'proto-1')).resolves.toBe(
      '2026-08-10T12:00:00.000Z',
    );
  });

  it('TBI-002 DoD-1 returns null when an artifact has no done event', async () => {
    mockDb.query.artifactDoneEvents.findFirst.mockResolvedValue(undefined);

    await expect(getArtifactDoneEventAt('interview', 'int-missing')).resolves.toBeNull();
  });
});
