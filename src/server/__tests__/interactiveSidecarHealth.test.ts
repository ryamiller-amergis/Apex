import {
  createActorInvocationStallTracker,
  createSidecarHealthMonitor,
  evaluateSidecarMetadata,
  interactiveHealthRoute,
} from '../services/interactiveActorHost/sidecarHealth';

const ACTOR = 'InteractiveSessionActorAgentic';

const healthyMetadata = {
  actorRuntime: {
    runtimeStatus: 'RUNNING',
    activeActors: [{ type: ACTOR, count: 2 }],
    hostReady: true,
    placement: 'placement: connected',
  },
};

describe('evaluateSidecarMetadata', () => {
  it('accepts a sidecar connected to placement that hosts the actor type', () => {
    expect(evaluateSidecarMetadata(healthyMetadata, ACTOR)).toEqual({ healthy: true });
  });

  it('accepts the older metadata shape that only lists actors', () => {
    expect(evaluateSidecarMetadata({ actors: [{ type: ACTOR, count: 0 }] }, ACTOR))
      .toEqual({ healthy: true });
  });

  it('reports a sidecar disconnected from placement', () => {
    expect(evaluateSidecarMetadata({
      actorRuntime: { ...healthyMetadata.actorRuntime, placement: 'placement: disconnected' },
    }, ACTOR)).toMatchObject({ healthy: false, problem: 'placement-disconnected' });
  });

  it('reports a sidecar that no longer hosts the actor type', () => {
    expect(evaluateSidecarMetadata({
      actorRuntime: { ...healthyMetadata.actorRuntime, activeActors: [] },
    }, ACTOR)).toMatchObject({ healthy: false, problem: 'actor-type-missing' });
  });
});

describe('createSidecarHealthMonitor', () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  function monitor(fetchMetadata: () => Promise<unknown>) {
    let now = 0;
    const requestSidecarShutdown = jest.fn().mockResolvedValue(undefined);
    const health = createSidecarHealthMonitor({
      actorType: ACTOR,
      fetchMetadata,
      requestSidecarShutdown,
      now: () => now,
      graceMs: 60_000,
    });
    return { health, requestSidecarShutdown, advance: (ms: number) => { now += ms; } };
  }

  it('stays degraded during the grace period, then reports unhealthy and restarts the sidecar once', async () => {
    const { health, requestSidecarShutdown, advance } = monitor(
      jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
    );

    await expect(health.check()).resolves.toMatchObject({
      status: 'degraded',
      problem: 'sidecar-unreachable',
    });
    advance(59_000);
    await expect(health.check()).resolves.toMatchObject({ status: 'degraded' });
    expect(requestSidecarShutdown).not.toHaveBeenCalled();

    advance(1_000);
    await expect(health.check()).resolves.toMatchObject({ status: 'unhealthy' });
    advance(10_000);
    await expect(health.check()).resolves.toMatchObject({ status: 'unhealthy' });
    expect(requestSidecarShutdown).toHaveBeenCalledTimes(1);
  });

  it('resets once the sidecar looks right again', async () => {
    const fetchMetadata = jest
      .fn()
      .mockResolvedValueOnce({ actorRuntime: { activeActors: [] } })
      .mockResolvedValueOnce(healthyMetadata)
      .mockResolvedValueOnce({ actorRuntime: { activeActors: [] } });
    const { health, advance } = monitor(fetchMetadata);

    await health.check();
    advance(70_000);
    await expect(health.check()).resolves.toEqual({ status: 'ok' });
    await expect(health.check()).resolves.toMatchObject({ status: 'degraded' });
  });

  it('treats repeated actor-invoke timeouts as unhealthy even when metadata looks right', async () => {
    let now = 0;
    const tracker = createActorInvocationStallTracker(3);
    const requestSidecarShutdown = jest.fn().mockResolvedValue(undefined);
    const health = createSidecarHealthMonitor({
      actorType: ACTOR,
      fetchMetadata: async () => healthyMetadata,
      invocationStall: () => tracker.stalledDetail(),
      requestSidecarShutdown,
      now: () => now,
      graceMs: 60_000,
    });

    tracker.recordTimedOut();
    tracker.recordTimedOut();
    await expect(health.check()).resolves.toEqual({ status: 'ok' });

    tracker.recordTimedOut();
    await expect(health.check()).resolves.toMatchObject({
      status: 'degraded',
      problem: 'actor-invocations-stalled',
      detail: '3 consecutive actor invocations timed out',
    });
    now = 60_000;
    await expect(health.check()).resolves.toMatchObject({ status: 'unhealthy' });
    expect(requestSidecarShutdown).toHaveBeenCalledTimes(1);

    tracker.recordCompleted();
    await expect(health.check()).resolves.toEqual({ status: 'ok' });
  });
});

describe('interactiveHealthRoute', () => {
  function response() {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
  }

  it.each([
    [{ status: 'ok' as const }, 200],
    [{ status: 'degraded' as const, problem: 'actor-type-missing' as const, detail: 'x' }, 200],
    [{ status: 'unhealthy' as const, problem: 'actor-type-missing' as const, detail: 'x' }, 503],
  ])('maps %o to HTTP %i', async (report, code) => {
    const res = response();
    await interactiveHealthRoute(async () => report)({} as never, res as never);
    expect(res.status).toHaveBeenCalledWith(code);
    expect(res.json).toHaveBeenCalledWith(report);
  });
});
