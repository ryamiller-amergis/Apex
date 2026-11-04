/**
 * S4 — `applyMergeOutcome` unit tests (TBI-022 DoD-1, TBI-023 DoD-2, PBI-024 AC-3 / VT-08, VT-12).
 */
import { applyMergeOutcome, type MergeOutcomeDeps } from '../services/build/mergeOutcome';

function createOutcomeDeps(repairAttemptsInitial = 0): MergeOutcomeDeps & {
  events: Array<{ eventType: string; message: string; detail?: Record<string, unknown> }>;
  requeuedTasks: Array<{ taskId: string; attempt: number; branchName: string }>;
  suspendedRuns: Array<{ runId: string; reason: string; message: string }>;
  dispatchedRuns: string[];
  allMergedRevisions: string[];
  getCounter: () => number;
} {
  let counter = repairAttemptsInitial;
  const events: Array<{ eventType: string; message: string; detail?: Record<string, unknown> }> = [];
  const requeuedTasks: Array<{ taskId: string; attempt: number; branchName: string }> = [];
  const suspendedRuns: Array<{ runId: string; reason: string; message: string }> = [];
  const dispatchedRuns: string[] = [];
  const allMergedRevisions: string[] = [];

  return {
    events,
    requeuedTasks,
    suspendedRuns,
    dispatchedRuns,
    allMergedRevisions,
    getCounter: () => counter,
    loadContext: async (taskId) => ({
      taskId,
      taskKey: 't-impl-1',
      attempt: 1,
      revisionId: 'rev-1',
      buildRunId: 'run-1',
      integrationBranch: 'apex/build/run-1',
      supportContacts: [{ userId: 'u1', displayName: 'Dana', email: 'dana@example.com' }],
      allNonOmittedPlanTasksMerged: false,
    }),
    requestRepairAttempt: async () => {
      if (counter < 2) {
        counter += 1;
        return { granted: true, used: counter };
      }
      return { granted: false, used: 2 };
    },
    requeueTaskForConflict: async (taskId, nextAttempt, branchName) => {
      requeuedTasks.push({ taskId, attempt: nextAttempt, branchName });
    },
    markTaskFailed: async () => undefined,
    suspendRun: async (runId, reason, message) => {
      suspendedRuns.push({ runId, reason, message });
    },
    appendEvent: async (ev) => {
      events.push(ev);
    },
    dispatchNext: async (runId) => {
      dispatchedRuns.push(runId);
    },
    onAllTasksMerged: async (revisionId) => {
      allMergedRevisions.push(revisionId);
    },
  };
}

describe('applyMergeOutcome (TBI-022 DoD-1, TBI-023 DoD-2, PBI-024 AC-3 / VT-08, VT-12)', () => {
  it('VT-12 Case A: conflict with repair_attempts = 0 spends 1 attempt, sets task ready with attempt 2 and non-nested branch, and dispatches', async () => {
    const deps = createOutcomeDeps(0);

    await applyMergeOutcome(
      'task-1',
      { outcome: 'conflict', prUrl: 'https://dev.azure.com/org/Apex/_git/repo/pullrequest/12' },
      deps,
    );

    expect(deps.getCounter()).toBe(1);
    expect(deps.requeuedTasks).toEqual([
      {
        taskId: 'task-1',
        attempt: 2,
        branchName: 'apex/build-task/run-1/t-impl-1-2',
      },
    ]);
    expect(deps.requeuedTasks[0].branchName.startsWith('apex/build/run-1/')).toBe(false);
    expect(deps.dispatchedRuns).toEqual(['run-1']);
    expect(deps.suspendedRuns).toHaveLength(0);
    expect(deps.events.map((e) => e.eventType)).toContain('repair.granted');
  });

  it('VT-12 Case B: conflict with repair_attempts = 2 suspends run with cap_reached and names support contacts', async () => {
    const deps = createOutcomeDeps(2);

    await applyMergeOutcome(
      'task-1',
      { outcome: 'conflict', prUrl: 'https://dev.azure.com/org/Apex/_git/repo/pullrequest/12' },
      deps,
    );

    expect(deps.getCounter()).toBe(2);
    expect(deps.requeuedTasks).toHaveLength(0);
    expect(deps.suspendedRuns).toHaveLength(1);
    expect(deps.suspendedRuns[0].reason).toBe('cap_reached');
    expect(deps.suspendedRuns[0].message).toContain('Dana');
    expect(deps.events.map((e) => e.eventType)).toContain('repair.denied');
  });

  it('VT-08 blocked_by_policy suspends run with configuration, names the branch and support contacts, and leaves counter unchanged', async () => {
    const deps = createOutcomeDeps(0);

    await applyMergeOutcome(
      'task-1',
      { outcome: 'blocked_by_policy', branch: 'apex/build/run-1' },
      deps,
    );

    expect(deps.getCounter()).toBe(0);
    expect(deps.suspendedRuns).toHaveLength(1);
    expect(deps.suspendedRuns[0].reason).toBe('configuration');
    expect(deps.suspendedRuns[0].message).toContain('apex/build/run-1');
    expect(deps.suspendedRuns[0].message).toContain('Dana');
  });
});
