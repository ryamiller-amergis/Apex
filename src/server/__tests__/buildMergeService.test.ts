/**
 * S4 — `mergeTaskBranch` unit tests (TBI-022 DoD-1..3, PBI-024 AC-0 / VT-03..VT-09).
 */
import { mergeTaskBranch, type MergeDeps } from '../services/build/buildMergeService';

function createFakeMergeDeps(overrides: Partial<MergeDeps> = {}): MergeDeps & {
  events: Array<{ eventType: string; message: string; detail?: Record<string, unknown> }>;
  taskStatuses: Map<string, string>;
  lockCalls: string[];
  adoCalls: string[];
} {
  const events: Array<{ eventType: string; message: string; detail?: Record<string, unknown> }> = [];
  const taskStatuses = new Map<string, string>([
    ['task-1', 'running'],
    ['task-chain-2', 'running'],
  ]);
  const lockCalls: string[] = [];
  const adoCalls: string[] = [];

  const base: MergeDeps = {
    withRevisionMergeLock: async (revisionId, fn) => {
      lockCalls.push(revisionId);
      return fn();
    },
    loadTaskAndRun: async (taskId) => ({
      task: {
        id: taskId,
        revisionId: 'rev-1',
        taskKey: 't-impl-1',
        status: (taskStatuses.get(taskId) as any) ?? 'running',
        attempt: 1,
        branchName: 'apex/build-task/run-12345678/t-impl-1-1',
        covers: ['AC-1', 'DOD-1'],
        chainHeadKey: 't-impl-1',
      },
      siblingTaskIdsOnBranch: ['task-1', 'task-chain-2'],
      run: {
        id: 'run-12345678-0000-4000-8000-000000000001',
        project: 'Apex',
        repository: 'apex-repo',
        status: 'building',
        integrationBranch: 'apex/build/run-12345678-0000-4000-8000-000000000001',
      },
    }),
    markTasksMerged: async (taskIds, _prId, _mergeCommit) => {
      for (const id of taskIds) taskStatuses.set(id, 'merged');
    },
    markTasksFailed: async (taskIds) => {
      for (const id of taskIds) taskStatuses.set(id, 'failed');
    },
    appendEvent: async (event) => {
      events.push(event);
    },
    ado: {
      getBranchHeadCommit: async () => {
        adoCalls.push('getBranchHeadCommit');
        return 'src-commit-1';
      },
      findPullRequestBySourceBranch: async () => {
        adoCalls.push('findPullRequestBySourceBranch');
        return null;
      },
      createPullRequest: async () => {
        adoCalls.push('createPullRequest');
        return {
          pullRequestId: 55,
          prUrl: 'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/55',
        };
      },
      getPullRequest: async () => {
        adoCalls.push('getPullRequest');
        return {
          status: 'completed',
          mergeStatus: 'succeeded',
          sourceCommit: 'src-commit-1',
          mergeCommit: 'merge-commit-99',
        };
      },
      completePullRequest: async () => {
        adoCalls.push('completePullRequest');
      },
      abandonPullRequest: async () => {
        adoCalls.push('abandonPullRequest');
      },
    },
    now: () => 1000,
    sleep: async () => undefined,
    trackDuration: () => undefined,
  };

  return Object.assign(base, overrides, {
    events,
    taskStatuses,
    lockCalls,
    adoCalls,
  });
}

describe('mergeTaskBranch (TBI-022 DoD-0..3 / VT-03..VT-09)', () => {
  it('VT-03 TBI-022 DoD-3 / PBI-024 AC-0 merges cleanly, redacts PR text, marks chain siblings merged, and appends merge.completed', async () => {
    let createdTitle = '';
    let createdDescription = '';
    const deps = createFakeMergeDeps({
      loadTaskAndRun: async (taskId) => ({
        task: {
          id: taskId,
          revisionId: 'rev-1',
          taskKey: 't-impl-1',
          status: 'running',
          attempt: 1,
          branchName: 'apex/build-task/run-1/t-impl-1-1',
          covers: ['AC-1', 'Bearer secretTokenValue12345'],
          chainHeadKey: 't-impl-1',
        },
        siblingTaskIdsOnBranch: ['task-1', 'task-chain-2'],
        run: {
          id: '12345678-0000-4000-8000-000000000001',
          project: 'Apex',
          repository: 'apex-repo',
          status: 'building',
          integrationBranch: 'apex/build/12345678-0000-4000-8000-000000000001',
        },
      }),
    });
    deps.ado.createPullRequest = async (opts) => {
      createdTitle = opts.title;
      createdDescription = opts.description;
      return {
        pullRequestId: 55,
        prUrl: 'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/55',
      };
    };

    const outcome = await mergeTaskBranch('task-1', deps);

    expect(outcome).toEqual({
      outcome: 'merged',
      mergeCommit: 'merge-commit-99',
      prUrl: 'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/55',
    });
    expect(createdTitle).toContain('Build 12345678 · t-impl-1 (attempt 1)');
    expect(createdDescription).toContain('AC-1');
    expect(createdDescription).not.toContain('secretTokenValue12345');
    expect(deps.taskStatuses.get('task-1')).toBe('merged');
    expect(deps.taskStatuses.get('task-chain-2')).toBe('merged');
    expect(deps.events.map((e) => e.eventType)).toContain('merge.completed');
  });

  it('VT-04 TBI-022 DoD-1, DoD-3 abandons PR on conflict, marks task failed, and appends merge.conflict', async () => {
    let abandoned = false;
    let completed = false;
    const deps = createFakeMergeDeps();
    deps.ado.getPullRequest = async () => ({
      status: 'active',
      mergeStatus: 'conflicts',
      sourceCommit: 'src-1',
      mergeCommit: null,
    });
    deps.ado.abandonPullRequest = async () => {
      abandoned = true;
    };
    deps.ado.completePullRequest = async () => {
      completed = true;
    };

    const outcome = await mergeTaskBranch('task-1', deps);

    expect(outcome).toEqual({
      outcome: 'conflict',
      prUrl: 'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/55',
    });
    expect(abandoned).toBe(true);
    expect(completed).toBe(false);
    expect(deps.taskStatuses.get('task-1')).toBe('failed');
    expect(deps.events.map((e) => e.eventType)).toContain('merge.conflict');
  });

  it('VT-05 TBI-022 DoD-2, DoD-3 returns already_merged with zero ADO calls for merged task, and recovers when PR is already completed in ADO', async () => {
    const deps = createFakeMergeDeps();
    deps.taskStatuses.set('task-1', 'merged');

    const first = await mergeTaskBranch('task-1', deps);
    const second = await mergeTaskBranch('task-1', deps);

    expect(first).toEqual({ outcome: 'already_merged' });
    expect(second).toEqual({ outcome: 'already_merged' });
    expect(deps.adoCalls).toHaveLength(0);

    // Case (ii): task running, ADO reports existing PR already completed
    const recoveryDeps = createFakeMergeDeps();
    let createCalled = false;
    recoveryDeps.ado.findPullRequestBySourceBranch = async () => ({
      pullRequestId: 88,
      status: 'completed',
    });
    recoveryDeps.ado.getPullRequest = async () => ({
      status: 'completed',
      mergeStatus: 'succeeded',
      sourceCommit: 'src-88',
      mergeCommit: 'mrg-88',
    });
    recoveryDeps.ado.createPullRequest = async () => {
      createCalled = true;
      return { pullRequestId: 89, prUrl: 'http://example/89' };
    };

    const recovered = await mergeTaskBranch('task-1', recoveryDeps);
    expect(recovered.outcome).toBe('merged');
    expect(createCalled).toBe(false);
    expect(recoveryDeps.taskStatuses.get('task-1')).toBe('merged');
  });

  it('VT-06 TBI-022 NFR serializes concurrent merges for the same revision behind the revision lock', async () => {
    const order: string[] = [];
    let lockChain = Promise.resolve();
    const deps = createFakeMergeDeps({
      withRevisionMergeLock: async (_revisionId, fn) => {
        const prev = lockChain;
        let release!: () => void;
        lockChain = new Promise<void>((r) => {
          release = r;
        });
        await prev;
        try {
          return await fn();
        } finally {
          release();
        }
      },
    });
    deps.ado.createPullRequest = async () => {
      order.push('create-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('create-end');
      return { pullRequestId: 55, prUrl: 'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/55' };
    };

    await Promise.all([mergeTaskBranch('task-1', deps), mergeTaskBranch('task-2', deps)]);
    expect(order).toEqual(['create-start', 'create-end', 'create-start', 'create-end']);
  });

  it('VT-07 TBI-022 NFR returns pending after 30s when mergeStatus stays queued without abandoning PR', async () => {
    let clock = 0;
    let abandoned = false;
    const deps = createFakeMergeDeps({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    deps.ado.getPullRequest = async () => ({
      status: 'active',
      mergeStatus: 'queued',
      sourceCommit: 'src-1',
      mergeCommit: null,
    });
    deps.ado.abandonPullRequest = async () => {
      abandoned = true;
    };

    const outcome = await mergeTaskBranch('task-1', deps);
    expect(outcome).toEqual({ outcome: 'pending' });
    expect(abandoned).toBe(false);
    expect(deps.taskStatuses.get('task-1')).toBe('running');
    expect(deps.events.map((e) => e.eventType)).toContain('merge.pending');
  });

  it('VT-08 TBI-022 DoD-1 returns blocked_by_policy and abandons PR when mergeStatus is rejectedByPolicy', async () => {
    let abandoned = false;
    const deps = createFakeMergeDeps();
    deps.ado.getPullRequest = async () => ({
      status: 'active',
      mergeStatus: 'rejectedByPolicy',
      sourceCommit: 'src-1',
      mergeCommit: null,
    });
    deps.ado.abandonPullRequest = async () => {
      abandoned = true;
    };

    const outcome = await mergeTaskBranch('task-1', deps);
    expect(outcome).toEqual({
      outcome: 'blocked_by_policy',
      branch: 'apex/build/run-12345678-0000-4000-8000-000000000001',
    });
    expect(abandoned).toBe(true);
  });

  it('VT-09 returns skipped_run_inactive with zero ADO calls when run is suspended, and merges after resume', async () => {
    let runStatus: 'suspended' | 'building' = 'suspended';
    const deps = createFakeMergeDeps({
      loadTaskAndRun: async (taskId) => ({
        task: {
          id: taskId,
          revisionId: 'rev-1',
          taskKey: 't-impl-1',
          status: 'running',
          attempt: 1,
          branchName: 'apex/build-task/run-1/t-impl-1-1',
          covers: ['AC-1'],
          chainHeadKey: null,
        },
        siblingTaskIdsOnBranch: [taskId],
        run: {
          id: 'run-1',
          project: 'Apex',
          repository: 'apex-repo',
          status: runStatus,
          integrationBranch: 'apex/build/run-1',
        },
      }),
    });

    const beforeResume = await mergeTaskBranch('task-1', deps);
    expect(beforeResume).toEqual({ outcome: 'skipped_run_inactive' });
    expect(deps.adoCalls).toHaveLength(0);

    runStatus = 'building';
    const afterResume = await mergeTaskBranch('task-1', deps);
    expect(afterResume.outcome).toBe('merged');
  });
});
