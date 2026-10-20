const startBoardDeliberation = jest.fn();
class BoardDeliberationInputError extends Error {}
jest.mock('../services/boardDeliberationService', () => ({
  BoardDeliberationInputError,
  startBoardDeliberation: (...args: unknown[]) => startBoardDeliberation(...args),
}));

const failStepRunForHuman = jest.fn().mockResolvedValue(true);
const suspendStepRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/playbookSteps/stepRuns', () => ({
  ...jest.requireActual('../services/playbookSteps/stepRuns'),
  failStepRunForHuman: (...args: unknown[]) => failStepRunForHuman(...args),
  suspendStepRun: (...args: unknown[]) => suspendStepRun(...args),
}));

import { executeBoardDeliberationStep } from '../services/playbookSteps/boardDeliberationAdapter';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

function context(): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-deliberation',
    stepId: 'deliberation',
    stepType: 'board-deliberation',
    project: 'Apex',
    initiatorUserId: 'user-1',
    config: {
      charter: 'Replace the ATS in phases.',
      reports: { operations: '{"role":"operations"}' },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('board deliberation adapter', () => {
  it('parks a start failure for human retry so Mastra remains suspended', async () => {
    startBoardDeliberation.mockRejectedValue(
      new BoardDeliberationInputError(
        'ATS board compliance report failed v3 validation.',
      ),
    );

    await expect(executeBoardDeliberationStep(context())).resolves.toEqual(
      expect.objectContaining({ kind: 'suspended' }),
    );
    expect(failStepRunForHuman).toHaveBeenCalledWith({
      stepRunId: 'step-run-deliberation',
      reason: 'ATS board compliance report failed v3 validation.',
    });
    expect(suspendStepRun).not.toHaveBeenCalled();
  });

  it('propagates unexpected start failures so the workflow records a real failure', async () => {
    startBoardDeliberation.mockRejectedValue(new Error('database unavailable'));

    await expect(executeBoardDeliberationStep(context())).rejects.toThrow(
      'database unavailable',
    );
    expect(failStepRunForHuman).not.toHaveBeenCalled();
    expect(suspendStepRun).not.toHaveBeenCalled();
  });

  it('correlates and suspends after deliberation starts', async () => {
    startBoardDeliberation.mockResolvedValue({
      sessionId: 'session-1',
      agentRunId: 'agent-run-1',
    });

    await expect(executeBoardDeliberationStep(context())).resolves.toEqual(
      expect.objectContaining({
        kind: 'suspended',
        agentRunId: 'agent-run-1',
      }),
    );
    expect(suspendStepRun).toHaveBeenCalledWith(
      expect.objectContaining({
        stepRunId: 'step-run-deliberation',
        agentRunId: 'agent-run-1',
        resumeToken: 'session-1',
      }),
    );
    expect(failStepRunForHuman).not.toHaveBeenCalled();
  });
});
