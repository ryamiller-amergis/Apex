/**
 * S10 — Build 90-day retention service tests (TBI-030 DoD-1, DoD-3 / VT-28..VT-33).
 */
import {
  RETENTION_DAYS_MS,
  runBuildRetentionPass,
  type RetentionCandidateRun,
} from '../services/buildRetentionService';

describe('buildRetentionService (TBI-030 DoD-1, DoD-3 / VT-28..VT-33)', () => {
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');

  it('VT-28, VT-29, VT-30, VT-31 TBI-030 DoD-1, DoD-3 purges ended runs >= 90 days, skips 89-day and non-terminal runs, preserves events when Blob delete throws, and is idempotent on repeat', async () => {
    const runs: Array<RetentionCandidateRun & { hasEvents: boolean }> = [
      {
        id: 'run-89d',
        project: 'Apex',
        status: 'accepted',
        endedAt: new Date(nowMs - 89 * 24 * 3600_000).toISOString(),
        hasEvents: true,
      },
      {
        id: 'run-90d-accepted',
        project: 'Apex',
        status: 'accepted',
        endedAt: new Date(nowMs - RETENTION_DAYS_MS).toISOString(),
        hasEvents: true,
      },
      {
        id: 'run-91d-cancelled',
        project: 'Apex',
        status: 'cancelled',
        endedAt: new Date(nowMs - 91 * 24 * 3600_000).toISOString(),
        hasEvents: true,
      },
      {
        id: 'run-92d-blob-fail',
        project: 'Apex',
        status: 'failed',
        endedAt: new Date(nowMs - 92 * 24 * 3600_000).toISOString(),
        hasEvents: true,
      },
      {
        id: 'run-needs-dev-100d',
        project: 'Apex',
        status: 'needs_developer',
        endedAt: new Date(nowMs - 100 * 24 * 3600_000).toISOString(),
        hasEvents: true,
      },
    ];

    const deletedPrefixes: string[] = [];
    const purgedRunEvents: string[] = [];

    const deps = {
      now: () => new Date(nowMs),
      withRetentionLock: async <T>(fn: () => Promise<T>) => fn(),
      listEligibleEndedRuns: async (cutoffIso: string, batchSize: number) => {
        const cutoff = Date.parse(cutoffIso);
        return runs
          .filter(
            (r) =>
              (r.status === 'accepted' || r.status === 'cancelled' || r.status === 'failed')
              && r.hasEvents
              && r.endedAt !== null
              && Date.parse(r.endedAt) <= cutoff,
          )
          .slice(0, batchSize);
      },
      deleteBlobEvidencePrefix: async (prefix: string) => {
        if (prefix.includes('run-92d-blob-fail')) {
          throw new Error('Blob storage timeout');
        }
        deletedPrefixes.push(prefix);
      },
      deleteRunEventsWithRetentionGuard: async (runId: string) => {
        purgedRunEvents.push(runId);
        const r = runs.find((item) => item.id === runId);
        if (r) r.hasEvents = false;
      },
      track: () => undefined,
    };

    const firstOutcome = await runBuildRetentionPass({ deps });
    expect(firstOutcome.eligible).toBe(3);
    expect(firstOutcome.purged).toBe(2);
    expect(firstOutcome.failed).toBe(1);
    expect(deletedPrefixes).toEqual([
      'Apex/run-90d-accepted/',
      'Apex/run-91d-cancelled/',
    ]);
    expect(purgedRunEvents).toEqual(['run-90d-accepted', 'run-91d-cancelled']);
    expect(runs.find((r) => r.id === 'run-89d')?.hasEvents).toBe(true);
    expect(runs.find((r) => r.id === 'run-92d-blob-fail')?.hasEvents).toBe(true);
    expect(runs.find((r) => r.id === 'run-needs-dev-100d')?.hasEvents).toBe(true);

    // Fix blob failure and run second pass -> only the previously failed run is eligible
    deps.deleteBlobEvidencePrefix = async (prefix: string) => {
      deletedPrefixes.push(prefix);
    };
    const secondOutcome = await runBuildRetentionPass({ deps });
    expect(secondOutcome.purged).toBe(1);
    expect(secondOutcome.failed).toBe(0);

    // Third pass -> 0 eligible, 0 purged
    const thirdOutcome = await runBuildRetentionPass({ deps });
    expect(thirdOutcome.eligible).toBe(0);
    expect(thirdOutcome.purged).toBe(0);
  });
});
