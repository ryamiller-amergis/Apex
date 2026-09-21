/**
 * V1/V2 completion convergence.
 *
 * V1 reaches terminal through `markTerminal`, which delegates the durable
 * write to the completion handler and then applies a set of effects the rest
 * of the platform depends on. V2 reaches terminal through the attempt
 * transaction in `runAttemptRepository`, which writes only the run header.
 * Both transports must end up applying the same effects.
 */
const mockNotifyRunEvent = jest.fn();
const mockWorkerTerminalReason = jest.fn();

jest.mock('../services/pgNotifyService', () => ({
  RUN_EVENT_SOURCE_INSTANCE: 'test-instance',
  nextRunEventSequence: jest.fn().mockReturnValue(7),
  notifyRunEvent: (...args: unknown[]) => mockNotifyRunEvent(...args),
}));

jest.mock('../services/workerTierTelemetry', () => ({
  workerTierTelemetry: {
    terminalReason: (...args: unknown[]) => mockWorkerTerminalReason(...args),
  },
}));

import { AI_RUN_V2_SCHEMA_VERSION } from '../../shared/types/aiRunV2';
import {
  applyTerminalRunEffects,
  type TerminalRunSubject,
} from '../services/agentRunTerminalEffects';
import { createResultConsumer } from '../services/aiOrchestrator/resultConsumer';
import { createRunAttemptRepository } from '../services/aiRunV2/runAttemptRepository';
import type { QueueConsumer } from '../services/aiOrchestrator/ports';

function terminalRun(
  overrides: Partial<TerminalRunSubject> = {},
): TerminalRunSubject {
  return {
    runId: 'run-1',
    threadId: 'thread-1',
    projectId: 'proj-1',
    lane: 'background',
    status: 'completed',
    fromStatus: 'running',
    terminalReason: null,
    dispatchMessageId: 'dispatch-1',
    ...overrides,
  };
}

function terminalResultMessage(overrides: Record<string, unknown> = {}) {
  return {
    lockToken: 'lock-r',
    messageId: 'm',
    deliveryCount: 1,
    body: {
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: 'evt-r',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      timestamp: '2026-09-21T12:00:00.000Z',
      kind: 'terminal',
      status: 'completed',
      artifactStatus: 'verified',
      manifestRef: {
        container: 'ai-run-artifacts',
        key: 'runs/run-1/attempts/1/manifest.json',
      },
      ...overrides,
    },
  };
}

function recordingConsumer(
  message: ReturnType<typeof terminalResultMessage> | null,
  completed: string[],
): QueueConsumer {
  return {
    receive: async () => message,
    complete: async (token) => {
      completed.push(token);
    },
    abandon: async () => undefined,
    deadLetter: async () => undefined,
  };
}

beforeEach(() => {
  mockNotifyRunEvent.mockReset().mockResolvedValue(undefined);
  mockWorkerTerminalReason.mockReset();
});

describe('shared terminal run effects', () => {
  it('publishes a durable done event when the terminal write did not persist one', async () => {
    await applyTerminalRunEffects({
      run: terminalRun(),
      detail: 'Prototype generated',
      terminalEventsPersisted: false,
      deactivateGrounding: jest.fn().mockResolvedValue(undefined),
    });

    expect(mockNotifyRunEvent).toHaveBeenCalledTimes(1);
    expect(mockNotifyRunEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        threadId: 'thread-1',
        type: 'done',
        phase: 'completion',
        status: 'completed',
        detail: 'Prototype generated',
        event: expect.objectContaining({ type: 'done', runId: 'run-1' }),
      }),
      { persist: true },
    );
  });

  it('does not republish when the terminal transaction already persisted its events', async () => {
    await applyTerminalRunEffects({
      run: terminalRun(),
      terminalEventsPersisted: true,
      deactivateGrounding: jest.fn().mockResolvedValue(undefined),
    });

    expect(mockNotifyRunEvent).not.toHaveBeenCalled();
  });

  it('deactivates grounding and reports the terminal reason for a background run', async () => {
    const order: string[] = [];
    mockNotifyRunEvent.mockImplementation(async () => {
      order.push('event');
    });
    const deactivateGrounding = jest.fn().mockImplementation(async () => {
      order.push('deactivate');
    });

    await applyTerminalRunEffects({
      run: terminalRun({ status: 'failed', terminalReason: 'worker_lost' }),
      terminalEventsPersisted: false,
      deactivateGrounding,
    });

    expect(order).toEqual(['event', 'deactivate']);
    expect(deactivateGrounding).toHaveBeenCalledWith('thread-1', 'proj-1');
    expect(mockWorkerTerminalReason).toHaveBeenCalledWith(
      {
        runId: 'run-1',
        project: 'proj-1',
        lane: 'background',
        dispatchMessageId: 'dispatch-1',
      },
      'worker_lost',
    );
  });

  it('never throws, so a caller can still acknowledge its terminal message', async () => {
    mockNotifyRunEvent.mockRejectedValue(new Error('notify unavailable'));

    await expect(
      applyTerminalRunEffects({
        run: terminalRun(),
        terminalEventsPersisted: false,
        deactivateGrounding: jest
          .fn()
          .mockRejectedValue(new Error('grounding unavailable')),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('V2 result consumer', () => {
  it('applies the shared terminal effects after a fenced finalize', async () => {
    const completed: string[] = [];
    const terminalEffects = jest.fn().mockResolvedValue(undefined);
    const handler = createResultConsumer({
      consumer: recordingConsumer(terminalResultMessage(), completed),
      attempts: {
        transitionAttempt: jest.fn().mockResolvedValue({
          status: 'ok',
          attemptId: 'attempt-1',
          to: 'completed',
          run: terminalRun(),
        }),
      } as never,
      applyTerminalRunEffects: terminalEffects,
    });

    await expect(handler.processOnce()).resolves.toBe('processed');
    expect(terminalEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        run: expect.objectContaining({
          runId: 'run-1',
          threadId: 'thread-1',
          status: 'completed',
        }),
        terminalEventsPersisted: false,
      }),
    );
    expect(completed).toEqual(['lock-r']);
  });

  it('does not apply terminal effects when the finalize lost its fence', async () => {
    const terminalEffects = jest.fn();
    const handler = createResultConsumer({
      consumer: recordingConsumer(terminalResultMessage(), []),
      attempts: {
        transitionAttempt: jest
          .fn()
          .mockResolvedValue({ status: 'fence_mismatch' }),
      } as never,
      applyTerminalRunEffects: terminalEffects,
    });

    await expect(handler.processOnce()).resolves.toBe('poison');
    expect(terminalEffects).not.toHaveBeenCalled();
  });
});

describe('V2 attempt transition', () => {
  it('returns the run header its own transaction wrote', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'attempt-1',
          run_id: 'run-1',
          status: 'running',
          dispatch_message_id: 'dispatch-1',
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'run-1',
          thread_id: 'thread-1',
          project_id: 'proj-1',
          lane: 'background',
          status: 'completed',
          terminal_reason: null,
          dispatch_message_id: 'dispatch-1',
        },
      ]);
    const repo = createRunAttemptRepository({
      runInTransaction: async (work) => work({ execute }),
    });

    const result = await repo.transitionAttempt({
      attemptId: 'attempt-1',
      expectedDispatchMessageId: 'dispatch-1',
      to: 'completed',
      artifactStatus: 'verified',
    });

    expect(result).toEqual({
      status: 'ok',
      attemptId: 'attempt-1',
      to: 'completed',
      run: {
        runId: 'run-1',
        threadId: 'thread-1',
        projectId: 'proj-1',
        lane: 'background',
        status: 'completed',
        fromStatus: 'running',
        terminalReason: null,
        dispatchMessageId: 'dispatch-1',
      },
    });
  });
});
