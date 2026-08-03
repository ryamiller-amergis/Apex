import { isExternalRunAbortEvent } from '../services/agentRunAbort';
import type { AgentRunEventEnvelope, AgentRunEventType, SseEvent } from '../../shared/types/chat';

function envelope(event: SseEvent | { type: 'cancel' }): AgentRunEventEnvelope {
  const type: AgentRunEventType =
    event.type === 'cancel'
    || event.type === 'health'
    || event.type === 'status'
    || event.type === 'done'
    || event.type === 'error'
    || event.type === 'phase'
    || event.type === 'token'
    || event.type === 'message'
    || event.type === 'retrying'
      ? (event.type as AgentRunEventType)
      : 'status';
  return {
    eventId: 'evt-1',
    threadId: 'thread-1',
    runId: 'run-1',
    sourceInstance: 'test',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type,
    phase: 'completion',
    status: 'failed',
    event: event as AgentRunEventEnvelope['event'],
  };
}

describe('isExternalRunAbortEvent', () => {
  it('treats cancel as an abort', () => {
    expect(isExternalRunAbortEvent(envelope({ type: 'cancel' }))).toBe(true);
  });

  it('treats reaper terminal health events as aborts', () => {
    expect(isExternalRunAbortEvent(envelope({
      type: 'health',
      health: 'progress_timeout',
      detail: 'No meaningful progress',
      runId: 'run-1',
      eventTimestamp: new Date().toISOString(),
    }))).toBe(true);
    expect(isExternalRunAbortEvent(envelope({
      type: 'health',
      health: 'worker_lost',
      detail: 'Worker lost',
      runId: 'run-1',
      eventTimestamp: new Date().toISOString(),
    }))).toBe(true);
    expect(isExternalRunAbortEvent(envelope({
      type: 'health',
      health: 'hard_timeout',
      detail: 'Hard limit',
      runId: 'run-1',
      eventTimestamp: new Date().toISOString(),
    }))).toBe(true);
  });

  it('ignores non-terminal health and normal stream events', () => {
    expect(isExternalRunAbortEvent(envelope({
      type: 'health',
      health: 'progress_stale',
      detail: 'stale',
      runId: 'run-1',
      eventTimestamp: new Date().toISOString(),
    }))).toBe(false);
    expect(isExternalRunAbortEvent(envelope({
      type: 'health',
      health: 'healthy',
      detail: 'ok',
      runId: 'run-1',
      eventTimestamp: new Date().toISOString(),
    }))).toBe(false);
    expect(isExternalRunAbortEvent(envelope({ type: 'token', text: 'hi' }))).toBe(false);
    expect(isExternalRunAbortEvent(envelope({ type: 'status', status: 'running' }))).toBe(false);
  });
});
