const capturePlaybookOutcomeFeedback = jest.fn();
const completeStepRun = jest.fn();

jest.mock('../services/playbookOutcomeFeedbackService', () => ({
  capturePlaybookOutcomeFeedback: (...args: unknown[]) =>
    capturePlaybookOutcomeFeedback(...args),
}));

jest.mock('../services/playbookSteps/stepRuns', () => ({
  ...jest.requireActual('../services/playbookSteps/stepRuns'),
  completeStepRun: (...args: unknown[]) => completeStepRun(...args),
}));

import { executeCaptureOutcomeFeedbackStep } from '../services/playbookSteps/outcomeFeedbackAdapter';
import type { PlaybookStepExecutionContext } from '../services/playbookSteps/stepRuns';

function context(): PlaybookStepExecutionContext {
  return {
    runId: 'run-1',
    stepRunId: 'step-run-1',
    stepId: 'capture-learning',
    stepType: 'capture-outcome-feedback',
    project: 'Apex',
    initiatorUserId: 'leader',
    config: {
      reviewStepId: 'ratify',
      sourceStepIds: ['chair', 'deliberation'],
      label: 'ATS board outcome',
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  completeStepRun.mockResolvedValue(undefined);
});

describe('executeCaptureOutcomeFeedbackStep', () => {
  it('completes from the stored outcome and does not start an agent', async () => {
    capturePlaybookOutcomeFeedback.mockResolvedValue({
      feedbackId: 'feedback-1',
      decision: 'rejected',
      sourceCount: 2,
      capturedAt: '2026-10-20T16:00:00.000Z',
    });

    const output = {
      feedbackId: 'feedback-1',
      decision: 'rejected',
      sourceCount: 2,
      capturedAt: '2026-10-20T16:00:00.000Z',
    };
    const outcome = await executeCaptureOutcomeFeedbackStep(context());

    expect(capturePlaybookOutcomeFeedback).toHaveBeenCalledWith({
      runId: 'run-1',
      captureStepRunId: 'step-run-1',
      reviewStepId: 'ratify',
      sourceStepIds: ['chair', 'deliberation'],
      label: 'ATS board outcome',
    });
    expect(outcome).toEqual({ kind: 'completed', output });
    expect(completeStepRun).toHaveBeenCalledWith({
      stepRunId: 'step-run-1',
      output,
    });
  });

  it('does not complete the step when the outcome cannot be stored', async () => {
    capturePlaybookOutcomeFeedback.mockRejectedValue(
      new Error('Review step "ratify" has no completed decision to learn from.')
    );

    await expect(executeCaptureOutcomeFeedbackStep(context())).rejects.toThrow(
      /no completed decision/
    );
    expect(completeStepRun).not.toHaveBeenCalled();
  });
});
