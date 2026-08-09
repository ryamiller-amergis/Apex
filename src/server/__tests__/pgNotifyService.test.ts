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
  finalizeReconciledAgentRun,
  finalizeOwnedAgentRun,
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

  it('PBI-001 AC-2 / BR-002 atomically finalizes only the owning non-terminal run', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'run-1' }] }) // CAS
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // event insert
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // chat_threads reset
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const release = jest.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release });
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await expect(finalizeOwnedAgentRun({
      runId: envelope.runId,
      threadId: envelope.threadId,
      ownerInstance: envelope.sourceInstance,
      status: 'failed',
      detail: 'Tool exceeded owner deadline',
      events: [envelope],
    })).resolves.toBe(true);

    expect(clientQuery.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'UPDATE',
      'INSERT',
      'UPDATE',
      'COMMIT',
    ]);
    expect(clientQuery.mock.calls[1][0]).toContain('owner_instance = $4');
    expect(clientQuery.mock.calls[1][0]).toContain(
      "status IN ('queued', 'dispatched', 'running')",
    );
    expect(mockPoolQuery).toHaveBeenCalledWith(
      expect.stringContaining('pg_notify'),
      expect.any(Array),
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('PBI-001 AC-2 emits no terminal when a competing terminal already won', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = jest.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release });

    await expect(finalizeOwnedAgentRun({
      runId: envelope.runId,
      threadId: envelope.threadId,
      ownerInstance: envelope.sourceInstance,
      status: 'failed',
      detail: 'Tool exceeded owner deadline',
      events: [envelope],
    })).resolves.toBe(false);

    expect(clientQuery.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      'BEGIN',
      expect.stringContaining('UPDATE agent_runs'),
      'ROLLBACK',
    ]);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('TBI-003 DoD-0 atomically reconciles a non-terminal run without owner identity', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = jest.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release });
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await expect(finalizeReconciledAgentRun({
      runId: envelope.runId,
      threadId: envelope.threadId,
      status: 'failed',
      detail: 'Run exceeded configured hard limit',
      events: [envelope],
    })).resolves.toBe(true);

    expect(clientQuery.mock.calls[1][0]).toContain(
      "status IN ('queued', 'dispatched', 'running')",
    );
    expect(clientQuery.mock.calls[1][0]).not.toContain('owner_instance');
    expect(clientQuery.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0]))
      .toEqual(['BEGIN', 'UPDATE', 'INSERT', 'UPDATE', 'COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('resets chat_threads to idle in the finalizer transaction after an interactive terminal', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'run-1' }] }) // CAS
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // event insert
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) // chat_threads reset
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    const release = jest.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release });
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await expect(finalizeReconciledAgentRun({
      runId: envelope.runId,
      threadId: envelope.threadId,
      status: 'completed',
      detail: 'Awaiting user input',
      events: [envelope],
    })).resolves.toBe(true);

    // The chat_threads reset runs inside the transaction, immediately before COMMIT.
    const threadReset = clientQuery.mock.calls[3];
    expect(String(threadReset[0])).toContain('UPDATE chat_threads');
    expect(String(threadReset[0])).toContain("status = 'idle'");
    expect(String(threadReset[0])).toContain('active_run_id = NULL');
    // CAS guard: only clear this run's own claim (or an already-cleared claim).
    expect(String(threadReset[0])).toContain('active_run_id = $3 OR active_run_id IS NULL');
    // A successful terminal clears last_error and targets the owning thread + run.
    expect(threadReset[1]).toEqual([null, envelope.threadId, envelope.runId]);
    // COMMIT follows the thread reset — the reset is durable, not a post-commit patch.
    expect(String(clientQuery.mock.calls[4][0]).trim()).toBe('COMMIT');
  });

  it('FEAT-001 VT-05 atomically fences terminal completion and stores its reason', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = jest.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release });
    mockPoolQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    await expect(finalizeReconciledAgentRun({
      runId: envelope.runId,
      threadId: envelope.threadId,
      status: 'failed',
      detail: 'Worker heartbeat expired',
      events: [envelope],
      dispatchMessageId: 'dispatch-1',
      terminalReason: 'worker_lost',
    })).resolves.toBe(true);

    expect(clientQuery.mock.calls[1][0]).toContain('dispatch_message_id = $4');
    expect(clientQuery.mock.calls[1][0]).toContain('terminal_reason = $5');
    expect(clientQuery.mock.calls[1][1]).toEqual([
      'failed',
      'Worker heartbeat expired',
      envelope.runId,
      'dispatch-1',
      'worker_lost',
    ]);
  });

  it('TBI-003 three-instance safety emits nothing when reconciliation CAS loses', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = jest.fn();
    mockPoolConnect.mockResolvedValue({ query: clientQuery, release });

    await expect(finalizeReconciledAgentRun({
      runId: envelope.runId,
      threadId: envelope.threadId,
      status: 'failed',
      detail: 'Run exceeded configured hard limit',
      events: [envelope],
    })).resolves.toBe(false);

    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
