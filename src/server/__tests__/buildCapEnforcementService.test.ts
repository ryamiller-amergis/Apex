/**
 * S4 — Cap enforcement service tests (TBI-029 DoD-0, PBI-037 AC-3 / VT-14..VT-18).
 */
import {
  checkRevisionCap,
  createBuildCapEnforcementService,
  MAX_ELAPSED_TICK_CLAMP_MS,
} from '../services/buildCapEnforcementService';

describe('buildCapEnforcementService (TBI-029 DoD-0, PBI-037 AC-3 / VT-14..VT-18)', () => {
  it('VT-14 TBI-029 DoD-0 accrues elapsed time normally and clamps a 3-hour gap to 120,000 ms', async () => {
    let storedElapsedMs = 60_000;
    let checkpointMs = 1_000_000;

    const service = createBuildCapEnforcementService({
      withCapLock: async (_runId, fn) => fn(),
      loadRunState: async () => ({
        runId: 'run-1',
        project: 'Apex',
        status: 'building',
        costUsedUsd: 1,
        costLimitUsd: 25,
        elapsedMs: storedElapsedMs,
        elapsedLimitMs: 4 * 3600_000,
        elapsedCheckpointAtMs: checkpointMs,
        revisionsUsed: 0,
        revisionsLimit: 5,
        parallelismLimit: 4,
        agentRuns: [],
      }),
      saveAccrual: async (_runId, nextElapsedMs, nextCheckpointMs) => {
        storedElapsedMs = nextElapsedMs;
        checkpointMs = nextCheckpointMs;
      },
      suspendForCap: async () => true,
    });

    // Normal 60s tick
    await service.enforceCaps('run-1', new Date(1_060_000));
    expect(storedElapsedMs).toBe(120_000);
    expect(checkpointMs).toBe(1_060_000);

    // 3-hour gap -> clamped to MAX_ELAPSED_TICK_CLAMP_MS (120_000 ms)
    const threeHoursLater = 1_060_000 + 3 * 3600_000;
    await service.enforceCaps('run-1', new Date(threeHoursLater));
    expect(storedElapsedMs).toBe(120_000 + MAX_ELAPSED_TICK_CLAMP_MS);
    expect(checkpointMs).toBe(threeHoursLater);
  });

  it('VT-15, VT-16, VT-18 TBI-029 DoD-0 / PBI-037 AC-3 suspends once when cost or parallelism crosses the limit', async () => {
    const suspensions: Array<{ runId: string; reason: string }> = [];
    let alreadySuspended = false;

    const service = createBuildCapEnforcementService({
      withCapLock: async (_runId, fn) => fn(),
      loadRunState: async () => ({
        runId: 'run-1',
        project: 'Apex',
        status: alreadySuspended ? 'suspended' : 'building',
        costUsedUsd: 10,
        costLimitUsd: 25,
        elapsedMs: 10_000,
        elapsedLimitMs: 4 * 3600_000,
        elapsedCheckpointAtMs: 1_000,
        revisionsUsed: 0,
        revisionsLimit: 5,
        parallelismLimit: 4,
        agentRuns: [
          {
            id: 'a-1',
            status: 'running',
            startedAtMs: 0,
            updatedAtMs: 60 * 60_000,
            rateUsdPerMinute: 0.5, // 60 mins * $0.50 = $30 >= $25 limit
          },
        ],
      }),
      saveAccrual: async () => undefined,
      suspendForCap: async (runId, crossing) => {
        if (alreadySuspended) return false;
        alreadySuspended = true;
        suspensions.push({ runId, reason: crossing.reason });
        return true;
      },
    });

    await Promise.all([
      service.enforceCaps('run-1', new Date(60 * 60_000)),
      service.enforceCaps('run-1', new Date(60 * 60_000)),
    ]);

    expect(suspensions).toEqual([{ runId: 'run-1', reason: 'cost_cap' }]);
  });

  it('VT-17 TBI-029 DoD-0 checkRevisionCap refuses the 6th revision with plain message', () => {
    expect(checkRevisionCap({ revisionsUsed: 4, revisionsLimit: 5 })).toEqual({
      allowed: true,
    });
    expect(checkRevisionCap({ revisionsUsed: 5, revisionsLimit: 5 })).toEqual({
      allowed: false,
      message: 'This build used its 5 revisions. Accept it or start a new build.',
    });
  });
});
