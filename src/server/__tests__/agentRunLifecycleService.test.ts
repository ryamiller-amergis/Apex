/**
 * FEAT-001 Formal Agent Run Lifecycle — VT-01..VT-07 / PBI-001 AC / TBI-001 DoD.
 */
const mockFindFirst = jest.fn();
const mockInsertValues = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockUpdateReturning = jest.fn();
const mockTransaction = jest.fn();
const mockRunAdmissionCycle = jest.fn();
const mockPersistThenMarkTerminalInactive = jest.fn();
const mockWorkerCancellation = jest.fn();
const mockWorkerTerminalReason = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      agentRuns: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: jest.fn(() => ({ values: mockInsertValues })),
    update: jest.fn(() => ({ set: mockUpdateSet })),
    transaction: (...args: unknown[]) => mockTransaction(...args),
  },
}));

jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'test-instance',
  nextRunEventSequence: jest.fn().mockReturnValue(1),
  notifyRunEvent: jest.fn().mockResolvedValue(undefined),
  finalizeReconciledAgentRun: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/admissionGovernorService', () => ({
  runAdmissionCycle: (...args: unknown[]) => mockRunAdmissionCycle(...args),
}));

jest.mock('../services/runGroundingService', () => ({
  runGroundingService: {
    persistThenMarkTerminalInactive: (...args: unknown[]) =>
      mockPersistThenMarkTerminalInactive(...args),
  },
}));

jest.mock('../services/workerTierTelemetry', () => ({
  workerTierTelemetry: {
    inflight: jest.fn(),
    queueDepth: jest.fn(),
    queueOldestAge: jest.fn(),
    projectInflight: jest.fn(),
    admissionWait: jest.fn(),
    coldStart: jest.fn(),
    cancellation: (...args: unknown[]) => mockWorkerCancellation(...args),
    reaperAction: jest.fn(),
    terminalReason: (...args: unknown[]) => mockWorkerTerminalReason(...args),
  },
}));

import {
  enqueue,
  transition,
  markTerminal,
  requestCancel,
  getExecutionSnapshot,
  isLegacyInProcessAgentRun,
  shouldApplyWorkerLifecycle,
  isLegalAgentRunTransition,
} from '../services/agentRunLifecycleService';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import {
  AGENT_RUN_STATUS_LABELS,
  isAgentRunTerminalReason,
} from '../../shared/types/agentRunLifecycle';
import { finalizeReconciledAgentRun } from '../services/pgNotifyService';
import { notifyRunEvent } from '../services/pgNotifyService';

const snapshot: ExecutionSnapshot = {
  prompt: 'generate design doc',
  model: 'claude-4',
  workspaceRef: 'ws://proj/repo@abc',
  workflowClass: 'design-doc',
  skillPath: '.cursor/skills/prd-design-spec/SKILL.md',
  projectId: 'proj-1',
  threadId: 'thread-1',
};

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    status: 'queued',
    projectId: 'proj-1',
    lane: 'background',
    queuedAt: '2026-08-05T12:00:00.000Z',
    dispatchedAt: null,
    dispatchMessageId: null,
    executionSnapshot: { ...snapshot },
    cancelRequested: false,
    cancelState: null,
    terminalReason: null,
    timeoutAt: '2026-08-05T14:00:00.000Z',
    ownerInstance: null,
    updatedAt: '2026-08-05T12:00:00.000Z',
    heartbeatAt: '2026-08-05T12:00:00.000Z',
    startedAt: '2026-08-05T12:00:00.000Z',
    createdAt: '2026-08-05T12:00:00.000Z',
    eventDriven: false,
    lastError: null,
    progressAt: null,
    progressLabel: null,
    progressPhase: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockFindFirst.mockReset();
  mockInsertValues.mockReset();
  mockUpdateSet.mockReset();
  mockUpdateWhere.mockReset();
  mockUpdateReturning.mockReset();
  mockTransaction.mockReset();
  mockRunAdmissionCycle.mockReset().mockResolvedValue({
    admitted: 0,
    inFlight: 0,
    limit: 10,
  });
  mockWorkerCancellation.mockReset();
  mockWorkerTerminalReason.mockReset();
  jest.mocked(notifyRunEvent).mockReset().mockResolvedValue(undefined);
  mockPersistThenMarkTerminalInactive.mockReset().mockImplementation(
    async (_run: unknown, persist: () => Promise<unknown>) => {
      await persist();
      return { persisted: undefined, deactivatedCount: 1 };
    },
  );
  jest.mocked(finalizeReconciledAgentRun).mockReset().mockResolvedValue(true);
  mockInsertValues.mockResolvedValue(undefined);
  mockUpdateSet.mockImplementation(() => ({
    where: (..._args: unknown[]) => {
      mockUpdateWhere(..._args);
      return { returning: mockUpdateReturning };
    },
  }));
});

describe('shared status vocabulary (TBI-001 / PBI-001 a11y NFR)', () => {
  it('exposes human-readable labels for every AgentRunStatus', () => {
    expect(AGENT_RUN_STATUS_LABELS.queued).toMatch(/Queued/);
    expect(AGENT_RUN_STATUS_LABELS.dispatched).toMatch(/Starting/);
    expect(AGENT_RUN_STATUS_LABELS.running).toBe('Running');
    expect(AGENT_RUN_STATUS_LABELS.completed).toBe('Completed');
    expect(AGENT_RUN_STATUS_LABELS.failed).toBe('Failed');
    expect(AGENT_RUN_STATUS_LABELS.cancelled).toBe('Cancelled');
  });

  it('accepts the closed terminalReason set from assumptions', () => {
    expect(isAgentRunTerminalReason('worker_lost')).toBe(true);
    expect(isAgentRunTerminalReason('progress_timeout')).toBe(true);
    expect(isAgentRunTerminalReason('queue_ttl')).toBe(true);
    expect(isAgentRunTerminalReason('forced_cancel')).toBe(true);
    expect(isAgentRunTerminalReason('worker-lost')).toBe(false);
    expect(isAgentRunTerminalReason('other')).toBe(false);
  });
});

describe('transition table (TBI-001 DoD-1 / VT-01 / VT-02)', () => {
  it('allows the happy-path edges queued→dispatched→running→completed', () => {
    expect(isLegalAgentRunTransition('queued', 'dispatched')).toBe(true);
    expect(isLegalAgentRunTransition('dispatched', 'running')).toBe(true);
    expect(isLegalAgentRunTransition('running', 'completed')).toBe(true);
    expect(isLegalAgentRunTransition('running', 'failed')).toBe(true);
    expect(isLegalAgentRunTransition('running', 'cancelled')).toBe(true);
  });

  it('rejects every transition out of a terminal state (AC-1 / VT-02)', () => {
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      for (const to of ['queued', 'dispatched', 'running', 'completed', 'failed', 'cancelled'] as const) {
        if (to === terminal) {
          expect(isLegalAgentRunTransition(terminal, to)).toBe(true);
        } else {
          expect(isLegalAgentRunTransition(terminal, to)).toBe(false);
        }
      }
    }
  });
});

describe('enqueue + frozen snapshot (PBI-001 AC-0 / AC-3 / VT-01 / VT-04 / DoD-2)', () => {
  it('AC-0 / VT-01: enqueue creates a queued worker row with frozen snapshot', async () => {
    const { runId } = await enqueue({
      threadId: 'thread-1',
      projectId: 'proj-1',
      snapshot,
      timeoutAt: '2026-08-05T14:00:00.000Z',
      runId: 'run-1',
    });

    expect(runId).toBe('run-1');
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'run-1',
        status: 'queued',
        lane: 'background',
        projectId: 'proj-1',
        executionSnapshot: snapshot,
        timeoutAt: '2026-08-05T14:00:00.000Z',
        progressPhase: 'queued',
        progressLabel: 'Queued — waiting for available worker',
      }),
    );
    expect(notifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'thread-1',
        runId: 'run-1',
        phase: 'queued',
        status: 'pending',
        detail: 'Queued — waiting for available worker',
        event: expect.objectContaining({
          type: 'phase',
          phase: 'queued',
          detail: 'Queued — waiting for available worker',
          runId: 'run-1',
        }),
      }),
      { persist: true },
    );
    expect(mockRunAdmissionCycle).toHaveBeenCalledWith('enqueue');
    expect(mockInsertValues.mock.invocationCallOrder[0])
      .toBeLessThan(jest.mocked(notifyRunEvent).mock.invocationCallOrder[0]);
    expect(jest.mocked(notifyRunEvent).mock.invocationCallOrder[0])
      .toBeLessThan(mockRunAdmissionCycle.mock.invocationCallOrder[0]);
    expect(JSON.stringify(jest.mocked(notifyRunEvent).mock.calls)).not.toMatch(
      /generate design doc|workspaceRef|snapshot|CURSOR_API_KEY/i,
    );
  });

  it('AC-3 / VT-04: mutating the input snapshot after enqueue does not change the stored copy', async () => {
    const mutable = { ...snapshot };
    await enqueue({
      threadId: 'thread-1',
      projectId: 'proj-1',
      snapshot: mutable,
      timeoutAt: '2026-08-05T14:00:00.000Z',
      runId: 'run-1',
    });
    const stored = (mockInsertValues.mock.calls[0][0] as { executionSnapshot: ExecutionSnapshot })
      .executionSnapshot;
    mutable.model = 'mutated-model';
    mutable.prompt = 'mutated-prompt';
    expect(stored.model).toBe('claude-4');
    expect(stored.prompt).toBe('generate design doc');
  });

  it('freezes optional checkoutRef on enqueue for thin shared-read snapshots', async () => {
    await enqueue({
      threadId: 'thread-1',
      projectId: 'proj-1',
      snapshot: {
        ...snapshot,
        workspaceRef: 'C:\\threads\\thread-1',
        checkoutRef: 'C:\\shared\\grounding-shared\\sha',
      },
      timeoutAt: '2026-08-05T14:00:00.000Z',
      runId: 'run-thin-1',
    });
    const stored = (mockInsertValues.mock.calls[0][0] as { executionSnapshot: ExecutionSnapshot })
      .executionSnapshot;
    expect(stored.workspaceRef).toBe('C:\\threads\\thread-1');
    expect(stored.checkoutRef).toBe('C:\\shared\\grounding-shared\\sha');
  });

  it('freezes optional mirrorRef and groundedSha on enqueue for bare-mirror snapshots', async () => {
    await enqueue({
      threadId: 'thread-1',
      projectId: 'proj-1',
      snapshot: {
        ...snapshot,
        workspaceRef: 'C:\\threads\\thread-1',
        mirrorRef: 'C:\\repo-cache\\apex.git',
        groundedSha: 'abc123',
        repository: 'apex/ai-pilot',
        provider: 'github',
      },
      timeoutAt: '2026-08-05T14:00:00.000Z',
      runId: 'run-mirror-1',
    });
    const stored = (mockInsertValues.mock.calls[0][0] as { executionSnapshot: ExecutionSnapshot })
      .executionSnapshot;
    expect(stored.workspaceRef).toBe('C:\\threads\\thread-1');
    expect(stored.mirrorRef).toBe('C:\\repo-cache\\apex.git');
    expect(stored.groundedSha).toBe('abc123');
    expect(stored.repository).toBe('apex/ai-pilot');
    expect(stored.provider).toBe('github');
    expect(stored.checkoutRef).toBeUndefined();
  });

  it('TBI-002 DoD-0: Given admission fails after insert, when enqueue returns, then the durable queued run is preserved', async () => {
    mockRunAdmissionCycle.mockRejectedValueOnce(new Error('admission unavailable'));

    await expect(enqueue({
      threadId: 'thread-1',
      projectId: 'proj-1',
      snapshot,
      timeoutAt: '2026-08-05T14:00:00.000Z',
      runId: 'run-1',
    })).resolves.toEqual({ runId: 'run-1' });

    expect(mockInsertValues).toHaveBeenCalledTimes(1);
    expect(mockRunAdmissionCycle).toHaveBeenCalledWith('enqueue');
  });

  it('AC-3 / VT-04: getExecutionSnapshot returns the frozen values even if caller mutates project defaults', async () => {
    mockFindFirst.mockResolvedValue(baseRow());
    const got = await getExecutionSnapshot('run-1');
    expect(got).toEqual(snapshot);
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

describe('happy-path lifecycle transitions (PBI-001 AC-0 / VT-01)', () => {
  it('AC-0: advances queued → dispatched → running → completed with intact snapshot', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ status: 'queued' }))
      .mockResolvedValueOnce(baseRow({
        status: 'dispatched',
        dispatchMessageId: 'D1',
        dispatchedAt: '2026-08-05T12:01:00.000Z',
      }))
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }))
      .mockResolvedValueOnce(baseRow({
        status: 'completed',
        dispatchMessageId: 'D1',
        executionSnapshot: snapshot,
      }));

    mockUpdateReturning
      .mockResolvedValueOnce([baseRow({
        status: 'dispatched',
        dispatchMessageId: 'D1',
        dispatchedAt: '2026-08-05T12:01:00.000Z',
      })])
      .mockResolvedValueOnce([baseRow({ status: 'running', dispatchMessageId: 'D1' })]);

    const d = await transition('run-1', 'dispatched', {
      expectedFrom: 'queued',
      dispatchMessageId: 'D1',
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.run.status).toBe('dispatched');
      expect(d.run.dispatchMessageId).toBe('D1');
    }

    const r = await transition('run-1', 'running', {
      expectedFrom: 'dispatched',
      dispatchMessageId: 'D1',
    });
    expect(r.ok).toBe(true);

    const completionHandler = jest.fn().mockResolvedValue(true);
    const t = await markTerminal('run-1', {
      status: 'completed',
      dispatchMessageId: 'D1',
      completionHandler,
    });
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.run.status).toBe('completed');
      expect(t.run.executionSnapshot).toEqual(snapshot);
    }
    expect(completionHandler).toHaveBeenCalledTimes(1);
    expect(mockRunAdmissionCycle).toHaveBeenCalledWith('slot-release');
    expect(completionHandler.mock.invocationCallOrder[0])
      .toBeLessThan(mockRunAdmissionCycle.mock.invocationCallOrder[0]);
  });
});

describe('illegal / fenced transitions (PBI-001 AC-1 / VT-02 / VT-05 / DoD-1)', () => {
  it('AC-1 / VT-02: transition from terminal returns conflict and does not update', async () => {
    mockFindFirst.mockResolvedValue(baseRow({ status: 'completed', dispatchMessageId: 'D1' }));
    const result = await transition('run-1', 'running', { dispatchMessageId: 'D1' });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.conflict).toBe(true);
      expect(result.run?.status).toBe('completed');
    }
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('VT-05: fence mismatch rejects transition without mutating the row', async () => {
    mockFindFirst.mockResolvedValue(
      baseRow({ status: 'running', dispatchMessageId: 'D1' }),
    );
    const result = await transition('run-1', 'completed', { dispatchMessageId: 'D0' });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('fence_mismatch');
    }
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});

describe('terminal idempotency (VT-06 / DoD-4)', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'BR-008 / DoD-3: %s background terminal deactivates only after terminal finalization',
    async (status) => {
      const order: string[] = [];
      mockFindFirst
        .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }))
        .mockResolvedValueOnce(baseRow({ status, dispatchMessageId: 'D1' }));
      const completionHandler = jest.fn().mockImplementation(async () => {
        order.push('terminal');
        return true;
      });
      const deactivateGrounding = jest.fn().mockImplementation(async () => {
        order.push('deactivate');
      });

      await expect(markTerminal('run-1', {
        status,
        dispatchMessageId: 'D1',
        completionHandler,
        deactivateGrounding,
      })).resolves.toEqual(expect.objectContaining({ ok: true }));

      expect(order).toEqual(['terminal', 'deactivate']);
      expect(deactivateGrounding).toHaveBeenCalledWith('thread-1', 'proj-1');
    },
  );

  it('BR-008 / DoD-3: non-terminal conflict leaves grounding active', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }))
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }));
    const deactivateGrounding = jest.fn();

    await markTerminal('run-1', {
      status: 'completed',
      dispatchMessageId: 'D1',
      completionHandler: jest.fn().mockResolvedValue(false),
      deactivateGrounding,
    });

    expect(deactivateGrounding).not.toHaveBeenCalled();
  });

  it('BR-008 / DoD-3: deactivation failure is best effort and does not undo terminal', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }))
      .mockResolvedValueOnce(baseRow({ status: 'completed', dispatchMessageId: 'D1' }));

    await expect(markTerminal('run-1', {
      status: 'completed',
      dispatchMessageId: 'D1',
      completionHandler: jest.fn().mockResolvedValue(true),
      deactivateGrounding: jest.fn().mockRejectedValue(new Error('cleanup failed')),
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      run: expect.objectContaining({ status: 'completed' }),
    }));
  });

  it('AC-0 / VT-06: first markTerminal uses the existing atomic durable finalizer', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }))
      .mockResolvedValueOnce(baseRow({
        status: 'failed',
        dispatchMessageId: 'D1',
        terminalReason: 'worker_lost',
      }));

    const result = await markTerminal('run-1', {
      status: 'failed',
      dispatchMessageId: 'D1',
      terminalReason: 'worker_lost',
      detail: 'Worker heartbeat expired',
    });

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.run.status).toBe('failed');
      expect(result.run.terminalReason).toBe('worker_lost');
    }
    expect(finalizeReconciledAgentRun).toHaveBeenCalledTimes(1);
    expect(finalizeReconciledAgentRun).toHaveBeenCalledWith({
      runId: 'run-1',
      threadId: 'thread-1',
      status: 'failed',
      detail: 'Worker heartbeat expired',
      events: [],
      dispatchMessageId: 'D1',
      terminalReason: 'worker_lost',
    });
    expect(mockRunAdmissionCycle).toHaveBeenCalledWith('slot-release');
    expect(mockWorkerTerminalReason).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        dispatchMessageId: 'D1',
        project: 'proj-1',
        lane: 'background',
      },
      'worker_lost',
    );
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('BR-008 / VT-06 / TBI-002 DoD-0: same-terminal retry skips completion but retries deactivation', async () => {
    mockFindFirst.mockResolvedValue(
      baseRow({ status: 'completed', dispatchMessageId: 'D1' }),
    );
    const completionHandler = jest.fn().mockResolvedValue(true);
    const deactivateGrounding = jest.fn().mockResolvedValue(undefined);
    const result = await markTerminal('run-1', {
      status: 'completed',
      dispatchMessageId: 'D1',
      completionHandler,
      deactivateGrounding,
    });
    expect(result.ok).toBe(true);
    expect(completionHandler).not.toHaveBeenCalled();
    expect(deactivateGrounding).toHaveBeenCalledWith('thread-1', 'proj-1');
    expect(mockRunAdmissionCycle).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('TBI-002 DoD-0: Given terminal finalization loses a conflict, when markTerminal returns, then slot release is not invoked', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }))
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }));
    const completionHandler = jest.fn().mockResolvedValue(false);

    const result = await markTerminal('run-1', {
      status: 'completed',
      dispatchMessageId: 'D1',
      completionHandler,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      reason: 'terminal_race_or_illegal',
    }));
    expect(mockRunAdmissionCycle).not.toHaveBeenCalled();
  });

  it('TBI-002 DoD-0: Given first terminal finalization wins but admission fails, when markTerminal returns, then completion remains successful', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ status: 'running', dispatchMessageId: 'D1' }))
      .mockResolvedValueOnce(baseRow({ status: 'completed', dispatchMessageId: 'D1' }));
    mockRunAdmissionCycle.mockRejectedValueOnce(new Error('admission unavailable'));

    await expect(markTerminal('run-1', {
      status: 'completed',
      dispatchMessageId: 'D1',
      completionHandler: jest.fn().mockResolvedValue(true),
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(mockRunAdmissionCycle).toHaveBeenCalledWith('slot-release');
  });
});

describe('legacy partitioning (PBI-001 AC-2 / VT-03 / DoD-3)', () => {
  it('AC-2: rows with no lane and no dispatch identity are legacy in-process', () => {
    expect(isLegacyInProcessAgentRun({ lane: null, dispatchMessageId: null })).toBe(true);
    expect(shouldApplyWorkerLifecycle({ lane: null, dispatchMessageId: null })).toBe(false);
    expect(isLegacyInProcessAgentRun({ lane: null, dispatchMessageId: 'historical-id' })).toBe(true);
    expect(shouldApplyWorkerLifecycle({ lane: null, dispatchMessageId: 'historical-id' })).toBe(false);
  });

  it('AC-2: background-lane rows use worker lifecycle even before fence assignment', () => {
    expect(isLegacyInProcessAgentRun({ lane: 'background', dispatchMessageId: null })).toBe(false);
    expect(shouldApplyWorkerLifecycle({ lane: 'background', dispatchMessageId: null })).toBe(true);
  });

  it('AC-2 / VT-03: worker-aware transition helpers do not backfill legacy rows', async () => {
    mockFindFirst.mockResolvedValue(
      baseRow({
        status: 'running',
        lane: null,
        dispatchMessageId: null,
        projectId: null,
        executionSnapshot: null,
        queuedAt: null,
      }),
    );
    const snap = await getExecutionSnapshot('run-1');
    expect(snap).toBeNull();
    expect(isLegacyInProcessAgentRun({ lane: null, dispatchMessageId: null })).toBe(true);
  });
});

describe('requestCancel (BR-002)', () => {
  it('BR-008 / DoD-3: cancels a queued run through terminal cleanup', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({ status: 'queued' }))
      .mockResolvedValueOnce(baseRow({ status: 'queued' }))
      .mockResolvedValueOnce(
        baseRow({ status: 'cancelled', terminalReason: 'forced_cancel' }),
      );
    const result = await requestCancel('run-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.run.status).toBe('cancelled');
      expect(result.run.terminalReason).toBe('forced_cancel');
    }
    expect(mockPersistThenMarkTerminalInactive).toHaveBeenCalledTimes(1);
  });

  it('sets cancel_requested for a dispatched run without forcing terminal', async () => {
    mockFindFirst.mockResolvedValue(
      baseRow({ status: 'dispatched', dispatchMessageId: 'D1' }),
    );
    mockUpdateReturning.mockResolvedValue([
      baseRow({
        status: 'dispatched',
        dispatchMessageId: 'D1',
        cancelRequested: true,
        cancelState: 'requested',
      }),
    ]);
    const result = await requestCancel('run-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.run.status).toBe('dispatched');
      expect(result.run.cancelRequested).toBe(true);
      expect(result.run.cancelState).toBe('requested');
    }
    expect(mockWorkerCancellation).toHaveBeenCalledWith({
      runId: 'run-1',
      dispatchMessageId: 'D1',
      project: 'proj-1',
      lane: 'background',
    });
  });

  it('TBI-008 DoD-2/security: successful queued cancellation emits only allowlisted identifiers', async () => {
    mockFindFirst
      .mockResolvedValueOnce(baseRow({
        status: 'queued',
        executionSnapshot: {
          ...snapshot,
          prompt: 'prompt=confidential',
          workspaceRef: 'C:\\private\\workspace',
        },
      }))
      .mockResolvedValueOnce(baseRow({ status: 'queued' }))
      .mockResolvedValueOnce(
        baseRow({ status: 'cancelled', terminalReason: 'forced_cancel' }),
      );

    await requestCancel('run-1');

    expect(mockWorkerCancellation).toHaveBeenCalledWith({
      runId: 'run-1',
      project: 'proj-1',
      lane: 'background',
    });
    expect(JSON.stringify(mockWorkerCancellation.mock.calls)).not.toMatch(
      /prompt=confidential|private\\\\workspace|snapshot|CURSOR_API_KEY/i,
    );
  });
});
