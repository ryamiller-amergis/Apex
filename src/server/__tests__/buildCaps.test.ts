/**
 * S3 — Pure cap evaluation, access, and resume stage derivation tests (TBI-029 DoD-0, PBI-037 AC-3 / VT-13).
 */
import { deriveResumeStage, evaluateCaps } from '../services/buildCaps';
import { canActOnBuild, computeAllowedActions } from '../services/buildRunAccess';

describe('buildCaps & buildRunAccess (TBI-029 DoD-0 / VT-13)', () => {
  it('VT-13 TBI-029 DoD-0 / PBI-037 AC-3 evaluates boundaries (limit - 1, limit, limit + 1) and checks cost before elapsed before parallelism', () => {
    const base = {
      costUsd: 24,
      costLimitUsd: 25,
      elapsedMs: 14_399_000,
      elapsedLimitMs: 14_400_000,
      revisionsUsed: 2,
      revisionsLimit: 5,
      runningAgents: 3,
      parallelismLimit: 4,
    };

    // All below limit -> null
    expect(evaluateCaps(base)).toBeNull();

    // Cost at limit -> cost_cap
    expect(evaluateCaps({ ...base, costUsd: 25 })).toEqual({
      reason: 'cost_cap',
      capName: 'cost',
      used: 25,
      limit: 25,
    });

    // Elapsed at limit -> elapsed_cap
    expect(evaluateCaps({ ...base, elapsedMs: 14_400_000 })).toEqual({
      reason: 'elapsed_cap',
      capName: 'elapsed',
      used: 14_400_000,
      limit: 14_400_000,
    });

    // Parallelism exceeds limit (strictly > limit per dispatcher rule, or >= when checking breach) -> parallelism_cap
    expect(evaluateCaps({ ...base, runningAgents: 5 })).toEqual({
      reason: 'parallelism_cap',
      capName: 'parallelism',
      used: 5,
      limit: 4,
    });

    // When both cost and elapsed cross, cost wins
    expect(
      evaluateCaps({ ...base, costUsd: 26, elapsedMs: 15_000_000 })?.reason,
    ).toBe('cost_cap');
  });

  it('derives resume stage and computes allowedActions accurately', () => {
    expect(deriveResumeStage({ hasValidatedPlan: false, tasks: [] })).toBe('planning');
    expect(
      deriveResumeStage({
        hasValidatedPlan: true,
        tasks: [{ status: 'merged' }, { status: 'ready' }],
      }),
    ).toBe('building');
    expect(
      deriveResumeStage({
        hasValidatedPlan: true,
        tasks: [{ status: 'merged' }],
      }),
    ).toBe('checking');

    const runBuilding = {
      requestedByUserId: 'u-req',
      status: 'building' as const,
      suspendReason: null,
    };
    expect(
      canActOnBuild(runBuilding, {
        userId: 'u-req',
        isProjectAdmin: false,
        isSuperAdmin: false,
      }),
    ).toBe(true);
    expect(
      canActOnBuild(runBuilding, {
        userId: 'u-other',
        isProjectAdmin: false,
        isSuperAdmin: false,
      }),
    ).toBe(false);

    expect(
      computeAllowedActions(runBuilding, {
        userId: 'u-req',
        isProjectAdmin: false,
        isSuperAdmin: false,
      }),
    ).toEqual({ cancel: true, resume: false });

    expect(
      computeAllowedActions(
        {
          requestedByUserId: 'u-req',
          status: 'suspended',
          suspendReason: 'cost_cap',
        },
        { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
      ),
    ).toEqual({ cancel: true, resume: true });

    expect(
      computeAllowedActions(
        {
          requestedByUserId: 'u-req',
          status: 'suspended',
          suspendReason: 'plan_invalid',
        },
        { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
      ),
    ).toEqual({ cancel: true, resume: false });
  });
});
