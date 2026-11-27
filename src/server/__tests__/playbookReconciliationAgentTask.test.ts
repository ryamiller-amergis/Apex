/**
 * The reconciliation sweep and the Agent task's two modes.
 *
 * One step type covers both. The sweep tells a chat with an assignee from an autonomous run by the
 * draft on the row. A chat turn that ended is recorded on the draft; it must never resume the
 * Playbook or fail the step. An autonomous run is resumed or failed as before.
 */
const selectQueue: unknown[][] = [];
const updateReturning = jest.fn();

jest.mock('../db/drizzle', () => {
  const selectChain = () => {
    const next = () => Promise.resolve(selectQueue.shift() ?? []);
    const chain: Record<string, unknown> = {};
    for (const name of ['from', 'innerJoin', 'where']) chain[name] = () => chain;
    chain.limit = () => next();
    chain.then = (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) =>
      next().then(resolve, reject);
    return chain;
  };
  return {
    db: {
      select: () => selectChain(),
      update: () => ({
        set: () => ({
          where: () => {
            const result = Promise.resolve([]) as Promise<unknown[]> & { returning?: () => Promise<unknown> };
            result.returning = () => Promise.resolve(updateReturning());
            return result;
          },
        }),
      }),
    },
  };
});

const advanceStalledRuns = jest.fn();
jest.mock('../services/playbookAdvanceService', () => ({
  advanceStalledRuns: (...a: unknown[]) => advanceStalledRuns(...a),
}));

const cursorAgentCompletionOutput = jest.fn();
jest.mock('../services/playbookSteps/cursorAgentCompletion', () => ({
  cursorAgentCompletionOutput: (...a: unknown[]) => cursorAgentCompletionOutput(...a),
}));

const recordInteractiveTurnFinished = jest.fn();
const warnInteractiveExpiring = jest.fn();
jest.mock('../services/playbookSteps/agentTaskChat', () => ({
  recordInteractiveTurnFinished: (...a: unknown[]) => recordInteractiveTurnFinished(...a),
  warnInteractiveExpiring: (...a: unknown[]) => warnInteractiveExpiring(...a),
}));

const resumeStepRun = jest.fn();
const failStepRun = jest.fn();
jest.mock('../services/playbookSteps/stepRuns', () => ({
  resumeStepRun: (...a: unknown[]) => resumeStepRun(...a),
  failStepRun: (...a: unknown[]) => failStepRun(...a),
}));

jest.mock('../services/playbookGateService', () => ({
  failGatesWithEmptyCurrentPools: jest.fn().mockResolvedValue(undefined),
}));

const getDesignDoc = jest.fn();
jest.mock('../services/designDocService', () => ({
  getDesignDoc: (...a: unknown[]) => getDesignDoc(...a),
  createDesignDocValidationAdapter: jest.fn(),
}));

jest.mock('../services/documentValidationService', () => ({
  ingestValidationScorecard: jest.fn().mockResolvedValue(undefined),
}));

import { runReconciliationPass } from '../services/playbookReconciliationService';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const draft = { threadId: 'thread-1', assigneeUserId: 'assignee-1' };

function stranded(overrides: Record<string, unknown>) {
  return {
    stepRunId: 'step-run-1',
    stepType: 'cursor-agent',
    outputInline: null,
    agentRunStatus: 'completed',
    agentRunId: 'agent-run-1',
    threadId: 'thread-1',
    completedAt: '2026-11-23T11:59:00.000Z',
    ...overrides,
  };
}

/** The sweep reads, in order: stranded steps, then (per autonomous expiry) a run input, then the orphan count. */
function sweepFinds(strandedRows: unknown[], extra: unknown[][] = []): void {
  selectQueue.length = 0;
  selectQueue.push(strandedRows, ...extra, [{ value: 0 }]);
}

beforeEach(() => {
  jest.clearAllMocks();
  selectQueue.length = 0;
  updateReturning.mockReset();
  updateReturning.mockResolvedValue([]);
  advanceStalledRuns.mockResolvedValue(0);
  recordInteractiveTurnFinished.mockResolvedValue(true);
  warnInteractiveExpiring.mockResolvedValue(undefined);
  resumeStepRun.mockResolvedValue(true);
  failStepRun.mockResolvedValue(undefined);
  cursorAgentCompletionOutput.mockResolvedValue({ agentRunId: 'agent-run-1', completedAt: 'x' });
});

describe('a finished agent run found by the sweep', () => {
  it('records a finished chat turn on the draft and does not resume the Playbook', async () => {
    sweepFinds([stranded({ outputInline: draft })]);

    const outcome = await runReconciliationPass({ clock: () => NOW });

    expect(recordInteractiveTurnFinished).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      agentRunId: 'agent-run-1',
      threadId: 'thread-1',
      failedReason: undefined,
    });
    expect(resumeStepRun).not.toHaveBeenCalled();
    expect(failStepRun).not.toHaveBeenCalled();
    expect(cursorAgentCompletionOutput).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ resumed: 1 });
  });

  it('records a failed chat turn on the draft instead of failing the step', async () => {
    sweepFinds([stranded({ outputInline: draft, agentRunStatus: 'failed' })]);

    await runReconciliationPass({ clock: () => NOW });

    expect(recordInteractiveTurnFinished).toHaveBeenCalledWith(
      expect.objectContaining({ failedReason: expect.stringContaining('found by the reconciliation sweep') }),
    );
    expect(failStepRun).not.toHaveBeenCalled();
    expect(resumeStepRun).not.toHaveBeenCalled();
  });

  it('does not count a chat turn that was already recorded', async () => {
    recordInteractiveTurnFinished.mockResolvedValue(false);
    sweepFinds([stranded({ outputInline: draft })]);

    await expect(runReconciliationPass({ clock: () => NOW })).resolves.toMatchObject({ resumed: 0 });
  });

  it('resumes an autonomous Agent task with its completion output', async () => {
    sweepFinds([stranded({ outputInline: null })]);

    const outcome = await runReconciliationPass({ clock: () => NOW });

    expect(recordInteractiveTurnFinished).not.toHaveBeenCalled();
    expect(resumeStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      output: { agentRunId: 'agent-run-1', completedAt: 'x' },
    });
    expect(outcome).toMatchObject({ resumed: 1 });
  });

  it('fails an autonomous Agent task retryably when its run did not complete', async () => {
    sweepFinds([stranded({ outputInline: null, agentRunStatus: 'cancelled' })]);

    await runReconciliationPass({ clock: () => NOW });

    expect(recordInteractiveTurnFinished).not.toHaveBeenCalled();
    expect(failStepRun).toHaveBeenCalledWith(
      expect.objectContaining({ stepRunId: 'step-run-1', retryable: true }),
    );
  });

  it('treats another step type holding the same shape as an ordinary step', async () => {
    sweepFinds([stranded({ stepType: 'cloud-agent', outputInline: draft })]);

    await runReconciliationPass({ clock: () => NOW });

    expect(recordInteractiveTurnFinished).not.toHaveBeenCalled();
    expect(resumeStepRun).toHaveBeenCalledTimes(1);
  });

  it('handles a mix of both modes in one pass', async () => {
    sweepFinds([
      stranded({ stepRunId: 'chat', outputInline: draft, agentRunId: 'run-chat' }),
      stranded({ stepRunId: 'solo', outputInline: null, agentRunId: 'run-solo' }),
    ]);

    const outcome = await runReconciliationPass({ clock: () => NOW });

    expect(recordInteractiveTurnFinished).toHaveBeenCalledTimes(1);
    expect(recordInteractiveTurnFinished).toHaveBeenCalledWith(expect.objectContaining({ stepRunId: 'chat' }));
    expect(resumeStepRun).toHaveBeenCalledTimes(1);
    expect(resumeStepRun).toHaveBeenCalledWith(expect.objectContaining({ stepRunId: 'solo' }));
    expect(outcome).toMatchObject({ resumed: 2 });
  });
});

describe('an Agent task that passed its deadline', () => {
  const runInput = [{ runInput: { documentType: 'design_doc', documentId: 'doc-1', validationThreadId: 'vt-1' } }];

  it('scores the validation thread for an autonomous task', async () => {
    getDesignDoc.mockResolvedValue({ id: 'doc-1' });
    updateReturning.mockResolvedValue([{ id: 'step-run-1', runId: 'run-1', stepType: 'cursor-agent', outputInline: null }]);
    sweepFinds([], [runInput]);

    const outcome = await runReconciliationPass({ clock: () => NOW });

    expect(getDesignDoc).toHaveBeenCalledWith('doc-1');
    expect(outcome).toMatchObject({ expired: 1 });
  });

  it('does not look for a validation thread when the task was a chat', async () => {
    updateReturning.mockResolvedValue([{ id: 'step-run-1', runId: 'run-1', stepType: 'cursor-agent', outputInline: draft }]);
    // No run-input read is queued: the chat path must not make one.
    sweepFinds([]);

    const outcome = await runReconciliationPass({ clock: () => NOW });

    expect(getDesignDoc).not.toHaveBeenCalled();
    expect(selectQueue).toHaveLength(0);
    expect(outcome).toMatchObject({ expired: 1, orphaned: 0 });
  });
});

describe('the sweep warns about chats before they expire', () => {
  it('asks once per pass', async () => {
    sweepFinds([]);

    await runReconciliationPass({ clock: () => NOW });

    expect(warnInteractiveExpiring).toHaveBeenCalledTimes(1);
    expect(warnInteractiveExpiring).toHaveBeenCalledWith(NOW);
  });
});
