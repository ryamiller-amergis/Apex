/**
 * S7 — Build deployment sweep scheduler tests (TBI-024, TBI-025 / VT-04, VT-14, VT-16).
 */
import { createBuildDeploymentSweepPass } from '../services/buildDeploymentScheduler';

describe('buildDeploymentScheduler (TBI-024, TBI-025 / VT-04, VT-14, VT-16)', () => {
  it('VT-14, VT-16 expires leases, fails stuck triggers (pipeline_run_id null > 2m), and polls stale deploying revisions (> 90s)', async () => {
    const grantedPairs: Array<{ project: string; repository: string }> = [];
    const settledCalls: Array<{
      pipelineRunId: string;
      status: 'succeeded' | 'failed';
      failedStage?: string;
    }> = [];
    const stuckFailedRevisions: string[] = [];

    const runSweep = createBuildDeploymentSweepPass({
      withSweepLock: async (fn) => fn(),
      expireLeases: async () => [{ project: 'Apex', repository: 'repo-expired' }],
      listPairsWithQueuedRevisions: async () => [{ project: 'Apex', repository: 'repo-queued' }],
      grantNext: async (project, repository) => {
        grantedPairs.push({ project, repository });
      },
      listStuckTriggerRevisions: async () => [
        { revisionId: 'rev-stuck', buildRunId: 'run-stuck' },
      ],
      failStuckTrigger: async (revisionId) => {
        stuckFailedRevisions.push(revisionId);
      },
      listStaleDeployingRevisions: async () => [
        {
          revisionId: 'rev-poll-ok',
          buildRunId: 'run-poll-ok',
          project: 'Apex',
          pipelineRunId: 'P-100',
          validatedCommit: 'a'.repeat(40),
          ageMs: 95_000,
          deadlineMs: 60 * 60_000,
        },
        {
          revisionId: 'rev-timeout',
          buildRunId: 'run-timeout',
          project: 'Apex',
          pipelineRunId: 'P-200',
          validatedCommit: 'b'.repeat(40),
          ageMs: 61 * 60_000,
          deadlineMs: 60 * 60_000,
        },
      ],
      pollPipelineBuild: async (_project, pipelineRunId) => {
        if (pipelineRunId === 'P-100') {
          return { completed: true, succeeded: true };
        }
        return { completed: false, succeeded: false };
      },
      settleDeployment: async (input) => {
        settledCalls.push({
          pipelineRunId: input.pipelineRunId,
          status: input.status,
          failedStage: input.failedStage,
        });
      },
    });

    const outcome = await runSweep();

    expect(outcome.skipped).toBe(false);
    expect(outcome.expiredLeases).toBe(1);
    expect(outcome.stuckTriggersFailed).toBe(1);
    expect(stuckFailedRevisions).toEqual(['rev-stuck']);
    expect(grantedPairs).toEqual([
      { project: 'Apex', repository: 'repo-expired' },
      { project: 'Apex', repository: 'repo-queued' },
    ]);
    expect(settledCalls).toEqual([
      { pipelineRunId: 'P-100', status: 'succeeded', failedStage: undefined },
      { pipelineRunId: 'P-200', status: 'failed', failedStage: 'timeout' },
    ]);
  });
});
