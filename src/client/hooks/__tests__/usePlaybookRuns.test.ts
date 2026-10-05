/**
 * The polling rule: refetch while anything is still moving, stop once everything is terminal.
 *
 * The predicates are tested directly rather than by driving timers through a rendered hook. What
 * matters here is the decision — which statuses count as live — and a fake-timer test would spend
 * its assertions on TanStack Query's scheduler instead, while leaving the decision itself covered
 * only by implication.
 */
import { hasLiveStep, isRunLive } from '../usePlaybookRuns';
import {
  PLAYBOOK_RUN_STATUSES,
  PLAYBOOK_STEP_RUN_STATUSES,
} from '../../../shared/types/playbook';
import type {
  PlaybookRunDetail,
  PlaybookStepRun,
  PlaybookStepRunStatus,
} from '../../../shared/types/playbook';

function step(status: PlaybookStepRunStatus): PlaybookStepRun {
  return {
    id: `row-${status}`,
    runId: 'run-1',
    stepId: status,
    stepType: 'notify',
    status,
    agentRunId: null,
    resumeToken: null,
    outputInline: null,
    outputBlobRef: null,
    expiresAt: null,
    startedAt: null,
    completedAt: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  };
}

function run(
  status: PlaybookRunDetail['status'],
  steps: PlaybookStepRun[]
): PlaybookRunDetail {
  return {
    runId: 'run-1',
    project: 'Apex',
    definitionName: 'Demo A',
    definitionVersionId: 'ver-1',
    versionNumber: 1,
    status,
    initiatorUserId: 'someone',
    startedAt: '2026-09-20T10:00:00.000Z',
    completedAt: null,
    steps,
    currentStepId: null,
    suspension: null,
  };
}

describe('isRunLive', () => {
  it('treats running and suspended as live', () => {
    expect(isRunLive('running')).toBe(true);
    // Suspended is live: a parked run is still going somewhere, and it is the state the demo
    // spends the most time in.
    expect(isRunLive('suspended')).toBe(true);
  });

  it('treats every terminal run status as finished', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'expired'] as const) {
      expect(isRunLive(status)).toBe(false);
    }
  });

  it('classifies every member of the run-status union', () => {
    // Guards against a status being added to the union and silently defaulting to "finished",
    // which would leave a live run frozen on screen.
    for (const status of PLAYBOOK_RUN_STATUSES) {
      expect(typeof isRunLive(status)).toBe('boolean');
    }
    expect(PLAYBOOK_RUN_STATUSES.filter(isRunLive).sort()).toEqual(['running', 'suspended']);
  });
});

describe('hasLiveStep', () => {
  it('is false when there is no run yet', () => {
    expect(hasLiveStep(undefined)).toBe(false);
  });

  it('keeps polling while any step is open, even after the run reads terminal', () => {
    // The gap this exists to cover: the run row closes out before, or after, its steps do.
    expect(hasLiveStep(run('completed', [step('completed'), step('running')]))).toBe(true);
    expect(hasLiveStep(run('completed', [step('completed'), step('pending')]))).toBe(true);
    expect(hasLiveStep(run('completed', [step('completed'), step('suspended')]))).toBe(true);
  });

  it('keeps polling while the run is live even if every step is terminal', () => {
    // The mirror of the case above: the last step has finished but the run has not been closed.
    expect(hasLiveStep(run('running', [step('completed')]))).toBe(true);
  });

  it('stops once the run and every step are terminal', () => {
    expect(hasLiveStep(run('completed', [step('completed'), step('completed')]))).toBe(false);
    expect(hasLiveStep(run('failed', [step('failed_retryable')]))).toBe(false);
    expect(hasLiveStep(run('expired', [step('expired')]))).toBe(false);
  });

  it('stops on a terminal run with no steps at all', () => {
    expect(hasLiveStep(run('cancelled', []))).toBe(false);
  });

  it('treats exactly the open step statuses as reasons to keep polling', () => {
    const keepsPolling = PLAYBOOK_STEP_RUN_STATUSES.filter((status) =>
      hasLiveStep(run('completed', [step(status)]))
    );

    expect([...keepsPolling].sort()).toEqual(['pending', 'running', 'suspended']);
  });
});
