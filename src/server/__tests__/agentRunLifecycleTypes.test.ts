import {
  AGENT_RUN_STATUS_LABELS,
  AGENT_RUN_TERMINAL_REASONS,
  isAgentRunTerminalReason,
  isAgentRunTerminalStatus,
} from '../../shared/types/agentRunLifecycle';

describe('FEAT-001 shared agent-run lifecycle contract', () => {
  it('PBI-001 accessibility NFR exposes a clear label for every lifecycle status', () => {
    expect(AGENT_RUN_STATUS_LABELS).toEqual({
      queued: 'Queued — waiting for available worker',
      dispatched: 'Starting…',
      running: 'Running',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    });
  });

  it('TBI-001 DoD-0 exposes the confirmed closed nullable terminal-reason vocabulary', () => {
    expect([...AGENT_RUN_TERMINAL_REASONS]).toEqual([
      'worker_lost',
      'progress_timeout',
      'queue_ttl',
      'forced_cancel',
    ]);
    expect(isAgentRunTerminalReason('worker_lost')).toBe(true);
    expect(isAgentRunTerminalReason('worker-lost')).toBe(false);
  });

  it('PBI-001 AC-1 recognizes only the canonical terminal statuses', () => {
    expect(['completed', 'failed', 'cancelled'].every(isAgentRunTerminalStatus)).toBe(true);
    expect(['queued', 'dispatched', 'running'].some(isAgentRunTerminalStatus)).toBe(false);
  });
});
