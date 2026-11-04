/**
 * S5 + S7 — Build run control service (cancel & resume) tests (PBI-035 AC-0..3, PBI-036 AC-0..3, TBI-029 DoD-1..3 / VT-01..VT-12, VT-39).
 */
import {
  BuildRunControlError,
  createBuildRunControlService,
  type ControlRunRecord,
} from '../services/buildRunControlService';

function createControlHarness(initial?: Partial<ControlRunRecord>) {
  const run: ControlRunRecord = {
    id: '00000000-0000-4000-8000-000000000001',
    project: 'Apex',
    status: 'building',
    suspendReason: null,
    requestedByUserId: 'u-req',
    costUsedUsd: 25,
    costLimitUsd: 25,
    elapsedMs: 1_000,
    elapsedLimitMs: 14_400_000,
    revisionsUsed: 1,
    revisionsLimit: 5,
    runningAgents: 1,
    parallelismLimit: 4,
    hasValidatedPlan: true,
    tasks: [{ status: 'merged' }, { status: 'ready' }],
    playbookRunId: 'pb-1',
    ...initial,
  };

  let profileCostLimitUsd = 25;
  const profileElapsedLimitMs = 14_400_000;
  let flagOperational = true;
  let requesterHasRunPermission = true;
  const preflightPasses = true;
  let stopResult = { stopped: 2, unconfirmed: [] as string[] };
  const events: Array<{ eventType: string; detail?: Record<string, unknown> }> = [];
  const leasesReleased: string[] = [];
  const playbooksCancelled: string[] = [];
  const reconciledRuns: string[] = [];

  const service = createBuildRunControlService({
    loadRun: async (buildId, projectId) =>
      run.id === buildId && run.project === projectId ? run : null,
    casCancelRun: async (buildId) => {
      if (run.id !== buildId) return { kind: 'not_found' };
      if (run.status === 'cancelled') return { kind: 'already_cancelled' };
      if (run.status === 'accepted' || run.status === 'failed') {
        return { kind: 'already_settled' };
      }
      run.status = 'cancelled';
      run.suspendReason = null;
      return { kind: 'cancelled' };
    },
    stopRunningAgents: async () => stopResult,
    releasePreviewLease: async (runId) => {
      leasesReleased.push(runId);
    },
    cancelPlaybookRun: async (playbookRunId) => {
      playbooksCancelled.push(playbookRunId);
    },
    readCurrentProfileCaps: async () => ({
      costLimitUsd: profileCostLimitUsd,
      elapsedLimitMs: profileElapsedLimitMs,
    }),
    isFlagOperational: async () => flagOperational,
    requesterHasBuildsRun: async () => requesterHasRunPermission,
    runConfigurationPreflight: async () => preflightPasses,
    casResumeRun: async (buildId, expectedReason, nextStage, updatedCaps) => {
      if (
        run.id !== buildId
        || run.status !== 'suspended'
        || run.suspendReason !== expectedReason
      ) {
        return false;
      }
      run.status = nextStage;
      run.suspendReason = null;
      if (updatedCaps?.costLimitUsd !== undefined) {
        run.costLimitUsd = updatedCaps.costLimitUsd;
      }
      if (updatedCaps?.elapsedLimitMs !== undefined) {
        run.elapsedLimitMs = updatedCaps.elapsedLimitMs;
      }
      return true;
    },
    reconcileRun: async (runId) => {
      reconciledRuns.push(runId);
    },
    appendEvent: async (ev) => {
      events.push(ev);
    },
    track: () => undefined,
  });

  return {
    run,
    events,
    leasesReleased,
    playbooksCancelled,
    reconciledRuns,
    setStopResult: (r: { stopped: number; unconfirmed: string[] }) => {
      stopResult = r;
    },
    setProfileCostLimitUsd: (v: number) => {
      profileCostLimitUsd = v;
    },
    setFlagOperational: (v: boolean) => {
      flagOperational = v;
    },
    setRequesterHasRunPermission: (v: boolean) => {
      requesterHasRunPermission = v;
    },
    service,
  };
}

describe('buildRunControlService (PBI-035, PBI-036, TBI-029 / VT-01..VT-12, VT-39)', () => {
  it('VT-01, VT-02, VT-03 PBI-035 AC-0..2 cancels running build, records unconfirmed agents, is idempotent on repeat, and refuses accepted build with 409 BUILD_ALREADY_SETTLED', async () => {
    const h = createControlHarness();
    h.setStopResult({ stopped: 1, unconfirmed: ['agent-hung'] });

    const first = await h.service.cancel({
      buildId: h.run.id,
      projectId: 'Apex',
      actor: { userId: 'u-req', isProjectAdmin: false, isSuperAdmin: false },
      reason: 'No longer needed',
    });

    expect(first.status).toBe('cancelled');
    expect(first.stoppedAgents).toBe(1);
    expect(first.unconfirmedAgents).toBe(1);
    expect(h.leasesReleased).toEqual([h.run.id]);
    expect(h.playbooksCancelled).toEqual(['pb-1']);
    expect(h.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['run_cancelled', 'agent_cancel_failed']),
    );

    // Repeat cancel -> alreadyCancelled: true
    const second = await h.service.cancel({
      buildId: h.run.id,
      projectId: 'Apex',
      actor: { userId: 'u-req', isProjectAdmin: false, isSuperAdmin: false },
    });
    expect(second.alreadyCancelled).toBe(true);

    // Cancel on accepted -> 409 BUILD_ALREADY_SETTLED
    const settledHarness = createControlHarness({ status: 'accepted' });
    await expect(
      settledHarness.service.cancel({
        buildId: settledHarness.run.id,
        projectId: 'Apex',
        actor: { userId: 'u-req', isProjectAdmin: false, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({
      code: 'BUILD_ALREADY_SETTLED',
      statusCode: 409,
    } satisfies Partial<BuildRunControlError>);
  });

  it('VT-04, VT-10 PBI-035 AC-3 / PBI-036 AC-3 refuses non-requester member without admin role with 403 FORBIDDEN', async () => {
    const h = createControlHarness({ status: 'suspended', suspendReason: 'cost_cap' });

    await expect(
      h.service.cancel({
        buildId: h.run.id,
        projectId: 'Apex',
        actor: { userId: 'u-other', isProjectAdmin: false, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });

    await expect(
      h.service.resume({
        buildId: h.run.id,
        projectId: 'Apex',
        actor: { userId: 'u-other', isProjectAdmin: false, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('VT-07, VT-08 PBI-036 AC-0, AC-1 refuses Resume when cost limit is unchanged, and restarts from last merged task once limit is raised', async () => {
    const h = createControlHarness({
      status: 'suspended',
      suspendReason: 'cost_cap',
      costUsedUsd: 25,
      costLimitUsd: 25,
    });

    // VT-08: cost limit unchanged -> 409 RESUME_CAUSE_NOT_CLEARED
    await expect(
      h.service.resume({
        buildId: h.run.id,
        projectId: 'Apex',
        actor: { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({
      code: 'RESUME_CAUSE_NOT_CLEARED',
      remainingCause: 'cost_cap',
      statusCode: 409,
    });
    expect(h.run.status).toBe('suspended');

    // VT-07: Project Admin raises profile cost limit to 50 -> Resume succeeds
    h.setProfileCostLimitUsd(50);
    const resumed = await h.service.resume({
      buildId: h.run.id,
      projectId: 'Apex',
      actor: { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
    });

    expect(resumed.status).toBe('building');
    expect(h.run.costLimitUsd).toBe(50);
    expect(h.reconciledRuns).toEqual([h.run.id]);
    expect(h.events.map((e) => e.eventType)).toContain('run_resumed');
  });

  it('VT-09, VT-11, VT-39 PBI-036 AC-1..2 handles flag_disabled, permission_revoked, and allows cancel when flag is off', async () => {
    const h = createControlHarness({
      status: 'suspended',
      suspendReason: 'flag_disabled',
    });
    h.setFlagOperational(false);

    // Flag still off -> Resume refused with remainingCause: flag_disabled
    await expect(
      h.service.resume({
        buildId: h.run.id,
        projectId: 'Apex',
        actor: { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({
      code: 'RESUME_CAUSE_NOT_CLEARED',
      remainingCause: 'flag_disabled',
      statusCode: 409,
    });

    // Flag back on -> Resume succeeds
    h.setFlagOperational(true);
    const res = await h.service.resume({
      buildId: h.run.id,
      projectId: 'Apex',
      actor: { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
    });
    expect(res.status).toBe('building');

    // VT-11: permission_revoked before and after builds:run is restored
    const permHarness = createControlHarness({
      status: 'suspended',
      suspendReason: 'permission_revoked',
    });
    permHarness.setRequesterHasRunPermission(false);
    await expect(
      permHarness.service.resume({
        buildId: permHarness.run.id,
        projectId: 'Apex',
        actor: { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({
      code: 'RESUME_CAUSE_NOT_CLEARED',
      remainingCause: 'permission_revoked',
    });

    permHarness.setRequesterHasRunPermission(true);
    const permResumed = await permHarness.service.resume({
      buildId: permHarness.run.id,
      projectId: 'Apex',
      actor: { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
    });
    expect(permResumed.status).toBe('building');
  });
});
