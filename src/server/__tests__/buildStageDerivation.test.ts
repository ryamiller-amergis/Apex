import { BUILD_RUN_STATUSES, type BuildRunStatus, type BuildTaskStatus } from '../../shared/types/build';
import { deriveBuildStage, deriveBuildTiming } from '../services/buildStageDerivation';

function tasks(...statuses: BuildTaskStatus[]) {
  return statuses.map((status) => ({ status }));
}

describe('deriveBuildStage', () => {
  const expected: Record<BuildRunStatus, { kind: 'stage' | 'exception'; key: string }> = {
    queued: { kind: 'stage', key: 'queued' },
    intake: { kind: 'stage', key: 'intake' },
    planning: { kind: 'stage', key: 'planning' },
    building: { kind: 'stage', key: 'building' },
    checking: { kind: 'stage', key: 'checking' },
    deploying: { kind: 'stage', key: 'deploying' },
    preview_ready: { kind: 'stage', key: 'preview_ready' },
    suspended: { kind: 'exception', key: 'suspended' },
    deployment_failed: { kind: 'exception', key: 'deployment_failed' },
    needs_developer: { kind: 'exception', key: 'needs_developer' },
    failed: { kind: 'exception', key: 'failed' },
    cancelled: { kind: 'exception', key: 'cancelled' },
    accepted: { kind: 'exception', key: 'accepted' },
  };

  it.each(BUILD_RUN_STATUSES.map((status) => [status]))(
    'VT-01 TBI-014 DoD-2 maps %s to its stage or exception',
    (status) => {
      const stage = deriveBuildStage({
        status,
        suspendReason: status === 'suspended' ? 'cost_cap' : null,
        tasks: [],
        queuePosition: status === 'queued' ? 2 : null,
      });
      expect({ kind: stage.kind, key: stage.key }).toEqual(expected[status]);
    },
  );

  it('VT-01 sets the queue position only for queued builds', () => {
    expect(deriveBuildStage({ status: 'queued', suspendReason: null, tasks: [], queuePosition: 3 }).queuePosition).toBe(3);
    expect(deriveBuildStage({ status: 'building', suspendReason: null, tasks: [], queuePosition: 3 }).queuePosition).toBeNull();
  });

  it('VT-02 PBI-016 AC-2 counts merged tasks against tasks that are not omitted', () => {
    const stage = deriveBuildStage({
      status: 'building',
      suspendReason: null,
      tasks: tasks('merged', 'merged', 'merged', 'running', 'pending', 'omitted'),
      queuePosition: null,
    });
    expect(stage.tasks).toEqual({ merged: 3, total: 5 });
  });

  it('VT-02 returns null tasks when the revision has none', () => {
    expect(deriveBuildStage({ status: 'planning', suspendReason: null, tasks: [], queuePosition: null }).tasks).toBeNull();
  });

  it('VT-03 PBI-016 AC-3 keeps a null suspend reason on a suspended build', () => {
    const stage = deriveBuildStage({ status: 'suspended', suspendReason: null, tasks: [], queuePosition: null });
    expect(stage).toMatchObject({ kind: 'exception', key: 'suspended', suspendReason: null });
  });

  it('VT-03 returns the suspend reason for a suspended build and drops it elsewhere', () => {
    expect(deriveBuildStage({ status: 'suspended', suspendReason: 'plan_invalid', tasks: [], queuePosition: null }).suspendReason)
      .toBe('plan_invalid');
    expect(deriveBuildStage({ status: 'failed', suspendReason: 'plan_invalid', tasks: [], queuePosition: null }).suspendReason)
      .toBeNull();
  });
});

describe('deriveBuildTiming', () => {
  const start = '2026-10-28T10:00:00.000Z';
  const now = new Date('2026-10-28T10:04:00.000Z');

  it('VT-04 PBI-016 AC-0 uses 300 seconds for small, 3600 for full, and none when unclassified', () => {
    const base = { startedAt: start, deployStartedAt: null, deployFinishedAt: null, endedAt: null, deploymentTimesKnown: true, now };
    expect(deriveBuildTiming({ ...base, classification: 'small' })).toMatchObject({ targetSeconds: 300, state: 'within', elapsedSeconds: 240 });
    expect(deriveBuildTiming({ ...base, classification: 'full' })).toMatchObject({ targetSeconds: 3600, state: 'within' });
    expect(deriveBuildTiming({ ...base, classification: null })).toMatchObject({ targetSeconds: null, state: 'none' });
  });

  it('VT-04 subtracts the deployment interval', () => {
    const timing = deriveBuildTiming({
      classification: 'small',
      startedAt: start,
      deployStartedAt: '2026-10-28T10:01:00.000Z',
      deployFinishedAt: '2026-10-28T10:03:00.000Z',
      endedAt: null,
      deploymentTimesKnown: true,
      now,
    });
    expect(timing).toEqual({ elapsedSeconds: 120, targetSeconds: 300, state: 'within', includesDeployment: false });
  });

  it('VT-04 marks the fallback as including deployment', () => {
    const timing = deriveBuildTiming({
      classification: 'small',
      startedAt: start,
      deployStartedAt: null,
      deployFinishedAt: null,
      endedAt: null,
      deploymentTimesKnown: false,
      now,
    });
    expect(timing.includesDeployment).toBe(true);
    expect(timing.elapsedSeconds).toBe(240);
  });

  it('VT-04 returns null elapsed before the start time exists', () => {
    const timing = deriveBuildTiming({
      classification: 'small',
      startedAt: null,
      deployStartedAt: null,
      deployFinishedAt: null,
      endedAt: null,
      deploymentTimesKnown: false,
      now,
    });
    expect(timing).toMatchObject({ elapsedSeconds: null, targetSeconds: 300, state: 'none' });
  });

  it('VT-04 reports over past the target and stops at the end time', () => {
    const timing = deriveBuildTiming({
      classification: 'small',
      startedAt: start,
      deployStartedAt: null,
      deployFinishedAt: null,
      endedAt: '2026-10-28T10:10:00.000Z',
      deploymentTimesKnown: true,
      now: new Date('2026-10-28T12:00:00.000Z'),
    });
    expect(timing).toMatchObject({ elapsedSeconds: 600, state: 'over' });
  });
});
