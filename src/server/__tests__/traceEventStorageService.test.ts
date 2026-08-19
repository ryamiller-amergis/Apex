/**
 * TBI-002 DoD-0 / VT-11 — re-redacted multi-row insert through Drizzle.
 */
jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockResolvedValue(undefined),
  });

  return {
    db: {
      insert: jest.fn().mockImplementation(makeInsertChain),
    },
  };
});

import { TRACE_REDACTED_MARKER, type SafeTraceEventInput } from '../../shared/types/observability';
import {
  insertSafeTraceEvents,
  TraceEventStorageError,
} from '../services/traceEventStorageService';
import { traceEvents } from '../db/schema';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: { insert: jest.Mock } };

const VALID_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

function safeEvent(overrides: Partial<SafeTraceEventInput> = {}): SafeTraceEventInput {
  return {
    eventType: 'api_request',
    occurredAt: '2026-08-17T16:00:00.000Z',
    actorUserId: 'user-oid-1',
    projectId: 'Apex',
    traceId: VALID_TRACE_ID,
    sessionId: 'session-1',
    routeTemplate: '/api/projects',
    httpMethod: 'GET',
    statusCode: 200,
    durationMs: 8,
    severity: 'info',
    details: { method: 'GET' },
    ...overrides,
  };
}

describe('insertSafeTraceEvents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const chain = { values: jest.fn().mockResolvedValue(undefined) };
    mockDb.insert.mockReturnValue(chain);
  });

  it('DoD-0 performs an empty-batch no-op without touching Drizzle', async () => {
    const result = await insertSafeTraceEvents([]);
    expect(result).toEqual({ insertedCount: 0 });
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('DoD-0 / VT-11 re-redacts injected secrets and performs one multi-row insert', async () => {
    const chain = { values: jest.fn().mockResolvedValue(undefined) };
    mockDb.insert.mockReturnValue(chain);

    const result = await insertSafeTraceEvents([
      safeEvent({
        details: {
          keep: 'visible',
          token: 'should-not-reach-db',
          headers: {
            authorization: 'Bearer still-secret',
            'content-type': 'application/json',
          },
        },
      }),
      safeEvent({
        eventType: 'error',
        details: { note: 'Bearer abc.def leftover' },
      }),
    ]);

    expect(result).toEqual({ insertedCount: 2 });
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).toHaveBeenCalledWith(traceEvents);
    expect(chain.values).toHaveBeenCalledTimes(1);

    const inserted = chain.values.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toEqual(
      expect.objectContaining({
        eventType: 'api_request',
        actorUserId: 'user-oid-1',
        traceId: VALID_TRACE_ID,
        routeTemplate: '/api/projects',
        httpMethod: 'GET',
        statusCode: 200,
        durationMs: 8,
      }),
    );
    const firstDetails = JSON.stringify(inserted[0].details);
    expect(firstDetails).toContain('visible');
    expect(firstDetails).toContain(TRACE_REDACTED_MARKER);
    expect(firstDetails).not.toContain('should-not-reach-db');
    expect(firstDetails).not.toContain('still-secret');
    expect(firstDetails).not.toContain('authorization');
    expect(JSON.stringify(inserted[1].details)).not.toContain('abc.def');
  });

  it('DoD-0 reports a typed failure without candidate content when insert rejects', async () => {
    const chain = { values: jest.fn().mockRejectedValue(new Error('Bearer db-secret failed')) };
    mockDb.insert.mockReturnValue(chain);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      insertSafeTraceEvents([
        safeEvent({ details: { token: 'candidate-secret', body: { leak: true } } }),
      ]),
    ).rejects.toBeInstanceOf(TraceEventStorageError);

    try {
      await insertSafeTraceEvents([
        safeEvent({ details: { token: 'candidate-secret' } }),
      ]);
    } catch (err) {
      expect((err as Error).message).toBe('insert_failed');
      expect((err as Error).message).not.toContain('candidate-secret');
      expect((err as Error).message).not.toContain('Bearer');
    }

    const logged = spy.mock.calls.map((call) => call.join(' ')).join(' ');
    expect(logged).toContain('insert_failed');
    expect(logged).not.toContain('candidate-secret');
    expect(logged).not.toContain('db-secret');
    spy.mockRestore();
  });
});
