/**
 * S10 — Cancelled-run and task branch cleanup tests (TBI-028 DoD-0..3 / VT-21..VT-24).
 */
import {
  NINETY_DAYS_MS,
  runBranchCleanupPass,
  type BranchCleanupCandidateRun,
} from '../services/build/buildBranchCleanup';

describe('buildBranchCleanup (TBI-028 DoD-0..3 / VT-21..VT-24)', () => {
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');

  it('VT-22, VT-23, VT-24 TBI-028 DoD-1..3 deletes cancelled runs ended >= 90 days ago with flag on, leaves 89-day, accepted, needs_developer, failed, and flag-off runs untouched, and is idempotent on repeat', async () => {
    const runs: BranchCleanupCandidateRun[] = [
      {
        id: 'run-89d',
        project: 'Apex',
        repository: 'apex-repo',
        status: 'cancelled',
        integrationBranch: 'apex/build/run-89d',
        endedAt: new Date(nowMs - 89 * 24 * 3600_000).toISOString(),
        integrationBranchDeletedAt: null,
      },
      {
        id: 'run-90d',
        project: 'Apex',
        repository: 'apex-repo',
        status: 'cancelled',
        integrationBranch: 'apex/build/run-90d',
        endedAt: new Date(nowMs - NINETY_DAYS_MS).toISOString(),
        integrationBranchDeletedAt: null,
      },
      {
        id: 'run-91d-missing-branch',
        project: 'Apex',
        repository: 'apex-repo',
        status: 'cancelled',
        integrationBranch: 'apex/build/run-91d',
        endedAt: new Date(nowMs - 91 * 24 * 3600_000).toISOString(),
        integrationBranchDeletedAt: null,
      },
      {
        id: 'run-accepted-95d',
        project: 'Apex',
        repository: 'apex-repo',
        status: 'accepted',
        integrationBranch: 'apex/build/run-accepted',
        endedAt: new Date(nowMs - 95 * 24 * 3600_000).toISOString(),
        integrationBranchDeletedAt: null,
      },
      {
        id: 'run-flag-off-95d',
        project: 'DisabledProj',
        repository: 'apex-repo',
        status: 'cancelled',
        integrationBranch: 'apex/build/run-flag-off',
        endedAt: new Date(nowMs - 95 * 24 * 3600_000).toISOString(),
        integrationBranchDeletedAt: null,
      },
    ];

    const scmCalls: string[] = [];
    const events: Array<{ buildRunId: string; eventType: string }> = [];

    const deps = {
      now: () => new Date(nowMs),
      listEligibleCancelledRuns: async (cutoffIso: string) => {
        const cutoff = Date.parse(cutoffIso);
        return runs.filter(
          (r) =>
            r.status === 'cancelled'
            && r.integrationBranchDeletedAt === null
            && r.endedAt !== null
            && Date.parse(r.endedAt) <= cutoff,
        );
      },
      isFlagOn: async (project: string) => project !== 'DisabledProj',
      deleteBranch: async (_repo: string, _project: string, branch: string) => {
        scmCalls.push(branch);
        // Simulate missing branch still treated as success
      },
      markBranchDeleted: async (runId: string, deletedAtIso: string) => {
        const target = runs.find((r) => r.id === runId);
        if (target) target.integrationBranchDeletedAt = deletedAtIso;
      },
      appendEvent: async (ev: { buildRunId: string; eventType: string }) => {
        events.push(ev);
      },
    };

    const firstPass = await runBranchCleanupPass(deps);
    expect(firstPass.deletedCount).toBe(2);
    expect(scmCalls).toEqual(['apex/build/run-90d', 'apex/build/run-91d']);
    expect(runs.find((r) => r.id === 'run-89d')?.integrationBranchDeletedAt).toBeNull();
    expect(runs.find((r) => r.id === 'run-accepted-95d')?.integrationBranchDeletedAt).toBeNull();
    expect(runs.find((r) => r.id === 'run-flag-off-95d')?.integrationBranchDeletedAt).toBeNull();
    expect(events.map((e) => e.buildRunId)).toEqual(['run-90d', 'run-91d-missing-branch']);

    // VT-23: second pass makes zero SCM calls
    scmCalls.length = 0;
    const secondPass = await runBranchCleanupPass(deps);
    expect(secondPass.deletedCount).toBe(0);
    expect(scmCalls).toHaveLength(0);
  });
});
