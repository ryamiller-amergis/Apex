const mockPoolQuery = jest.fn();
const mockPoolConnect = jest.fn();

jest.mock('../db', () => ({
  __esModule: true,
  default: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: (...args: unknown[]) => mockPoolConnect(...args),
  },
}));

import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import {
  notifyRunEvent,
  replayRunEvents,
  subscribeRunEvents,
} from '../services/pgNotifyService';

const envelope: AgentRunEventEnvelope = {
  eventId: '3f44f6f1-ec42-4aa6-9df4-0d8ce8438491',
  threadId: 'thread-1',
  runId: 'run-1',
  sourceInstance: 'worker-a',
  sequence: 1,
  timestamp: '2026-07-14T12:00:00.000Z',
  type: 'tool',
  phase: 'testing',
  status: 'running',
  detail: 'Running server tests',
  event: {
    type: 'tool_status',
    toolName: 'Shell',
    callId: 'call-1',
    status: 'running',
    args: { keys: ['command'] },
  },
};

describe('pgNotifyService durable run events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists a durable envelope before notifying other workers', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await notifyRunEvent(envelope, { persist: true });

    expect(mockPoolQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT INTO agent_run_events'),
      expect.arrayContaining([
        envelope.eventId,
        envelope.threadId,
        envelope.runId,
      ])
    );
    expect(mockPoolQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('pg_notify'),
      expect.arrayContaining([
        'agent_run_events',
        expect.stringContaining(envelope.eventId),
      ])
    );
  });

  it('replays durable envelopes after an SSE event id in ordinal order', async () => {
    mockPoolQuery.mockResolvedValue({
      rows: [
        {
          event_id: envelope.eventId,
          thread_id: envelope.threadId,
          run_id: envelope.runId,
          source_instance: envelope.sourceInstance,
          sequence: envelope.sequence,
          event_timestamp: envelope.timestamp,
          event_type: envelope.type,
          phase: envelope.phase,
          status: envelope.status,
          detail: envelope.detail,
          event: envelope.event,
        },
      ],
    });

    await expect(
      replayRunEvents(envelope.threadId, 'prior-event-id')
    ).resolves.toEqual([envelope]);
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('cursor.ordinal'),
      [envelope.threadId, 'prior-event-id', 500]
    );
  });

  it('deduplicates repeated PostgreSQL delivery by event id', () => {
    const callback = jest.fn();
    const unsubscribe = subscribeRunEvents(envelope.threadId, callback);

    // Test hook exercises the same dispatch path used by LISTEN/NOTIFY.
    const { dispatchRunEventForTest } = jest.requireActual(
      '../services/pgNotifyService'
    );
    dispatchRunEventForTest(envelope);
    dispatchRunEventForTest(envelope);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(envelope);
    unsubscribe();
  });
});
