import type {
  ArtifactCycleTimeData,
  IncompletePipelineData,
} from '../../shared/types/homeDashboard';
import {
  createHomeDashboardService,
  type HomeDashboardDependencies,
} from '../services/homeDashboardService';

const pipeline: IncompletePipelineData = {
  groups: [{
    key: 'interview',
    label: 'Interviews',
    count: 1,
    rows: [{
      id: 'iv-1',
      name: 'Interview',
      route: '/backlog/interview/iv-1',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ageDays: 30,
    }],
    viewAllHref: '/backlog?tab=interviews',
  }],
  updatedAt: '2026-08-31T00:00:00.000Z',
};

const medians: ArtifactCycleTimeData = {
  interview: { medianDays: 2, sampleSize: 2, windowDays: 90 },
  prd: { medianDays: 3, sampleSize: 2, windowDays: 90 },
  testCase: { medianDays: 1, sampleSize: 1, windowDays: 90 },
  prototype: { medianDays: 4, sampleSize: 1, windowDays: 90 },
  designDoc: { medianDays: 5, sampleSize: 1, windowDays: 90 },
};

function dependencies(
  overrides: Partial<HomeDashboardDependencies> = {},
): HomeDashboardDependencies {
  return {
    getUserPermissions: jest.fn().mockResolvedValue(new Set([
      'interviews:view',
      'dev-workbench:view',
      'calendar:view',
      'planning:releases',
    ])),
    getMenuConfig: jest.fn().mockResolvedValue({ project: 'Alpha', enabledViews: ['backlog'] }),
    getUserGroupNames: jest.fn().mockResolvedValue(['Developer']),
    getIncompletePipeline: jest.fn().mockResolvedValue(pipeline),
    getArtifactCycleTime: jest.fn().mockResolvedValue(medians),
    getMyWorkSummary: jest.fn().mockResolvedValue({
      readyCount: 3,
      inProgressCount: 2,
      medianCompletionDays: 6,
      sampleSize: 4,
    }),
    getDefectRollup: jest.fn().mockResolvedValue({
      projectOpenDefectCount: 2,
      pbiRows: [{
        pbiId: 42,
        title: 'Checkout',
        changedAt: '2026-08-30T00:00:00.000Z',
        openDefectCount: 2,
      }],
    }),
    getDeliveryCycleTime: jest.fn().mockResolvedValue({
      medianCycleTimeDays: 8,
      releases: [{
        workItemId: 42,
        releaseName: '1.2.0',
        devStartedAt: '2026-08-01T00:00:00.000Z',
        productionDeployedAt: '2026-08-09T00:00:00.000Z',
        cycleTimeDays: 8,
      }],
    }),
    trackEvent: jest.fn(),
    ...overrides,
  };
}

describe('HomeDashboardService', () => {
  it('TBI-001 DoD-0 / VT-02 composes every authorized populated tile and maps source fields', async () => {
    const deps = dependencies();
    const service = createHomeDashboardService(deps);

    const result = await service.getDashboard({
      userId: 'user-1',
      project: 'Alpha',
      isSuperAdmin: false,
    });

    expect(result.incompletePipeline).toEqual({ status: 'ok', data: pipeline });
    expect(result.artifactCycleTime).toEqual({ status: 'ok', data: medians });
    expect(result.myWork).toEqual({
      status: 'ok',
      data: {
        ready: 3,
        inProgress: 2,
        cycleTime: { medianDays: 6, sampleSize: 4, windowDays: 90 },
      },
    });
    expect(result.openBugsOnPbis).toEqual({
      status: 'ok',
      data: {
        totalOpenBugs: 2,
        rows: [{
          pbiId: '42',
          title: 'Checkout',
          openBugCount: 2,
          updatedAt: '2026-08-30T00:00:00.000Z',
        }],
      },
    });
    expect(result.devToProduction).toEqual({
      status: 'ok',
      data: { medianDays: 8, sampleSize: 1, windowDays: 90 },
    });
    expect(deps.getMyWorkSummary).toHaveBeenCalledWith({
      userId: 'user-1',
      project: 'Alpha',
    });
    expect(deps.trackEvent).toHaveBeenCalledTimes(5);
  });

  it('TBI-001 DoD-1 / VT-06 omits unauthorized tiles and never calls their sources', async () => {
    const deps = dependencies({
      getUserPermissions: jest.fn().mockResolvedValue(new Set()),
      getMenuConfig: jest.fn().mockResolvedValue({ project: 'Alpha', enabledViews: [] }),
      getUserGroupNames: jest.fn().mockResolvedValue([]),
    });

    const result = await createHomeDashboardService(deps).getDashboard({
      userId: 'user-1',
      project: 'Alpha',
      isSuperAdmin: false,
    });

    expect(result).toEqual({
      incompletePipeline: null,
      artifactCycleTime: null,
      myWork: null,
      openBugsOnPbis: null,
      devToProduction: null,
    });
    expect(deps.getIncompletePipeline).not.toHaveBeenCalled();
    expect(deps.getArtifactCycleTime).not.toHaveBeenCalled();
    expect(deps.getMyWorkSummary).not.toHaveBeenCalled();
    expect(deps.getDefectRollup).not.toHaveBeenCalled();
    expect(deps.getDeliveryCycleTime).not.toHaveBeenCalled();
  });

  it('PBI-001/002/003 AC-3 / VT-06 applies menu, group, and permission gates independently', async () => {
    const deps = dependencies({
      getMenuConfig: jest.fn().mockResolvedValue({ project: 'Alpha', enabledViews: [] }),
      getUserGroupNames: jest.fn().mockResolvedValue([]),
    });

    const result = await createHomeDashboardService(deps).getDashboard({
      userId: 'user-1',
      project: 'Alpha',
      isSuperAdmin: false,
    });

    expect(result.incompletePipeline).toBeNull();
    expect(result.artifactCycleTime).toBeNull();
    expect(result.myWork).toBeNull();
    expect(result.openBugsOnPbis?.status).toBe('ok');
    expect(result.devToProduction?.status).toBe('ok');
    expect(deps.getIncompletePipeline).not.toHaveBeenCalled();
    expect(deps.getArtifactCycleTime).not.toHaveBeenCalled();
    expect(deps.getMyWorkSummary).not.toHaveBeenCalled();
  });

  it('PBI-001/002 AC-3 / VT-06 lets Super Admin read interview tiles without permission or menu calls', async () => {
    const deps = dependencies({
      getUserPermissions: jest.fn().mockResolvedValue(new Set()),
    });

    const result = await createHomeDashboardService(deps).getDashboard({
      userId: 'admin-1',
      project: 'Alpha',
      isSuperAdmin: true,
    });

    expect(result.incompletePipeline?.status).toBe('ok');
    expect(result.artifactCycleTime?.status).toBe('ok');
    expect(deps.getMenuConfig).not.toHaveBeenCalled();
    expect(deps.getIncompletePipeline).toHaveBeenCalledWith('Alpha');
    expect(deps.getArtifactCycleTime).toHaveBeenCalledWith('Alpha');
  });

  it('TBI-001 DoD-2 / VT-10 isolates source failures from successful siblings', async () => {
    const deps = dependencies({
      getIncompletePipeline: jest.fn().mockRejectedValue(new Error('database unavailable')),
      getMyWorkSummary: jest.fn().mockRejectedValue(new Error('work source unavailable')),
      getDefectRollup: jest.fn().mockRejectedValue(new Error('ADO unavailable')),
    });

    const result = await createHomeDashboardService(deps).getDashboard({
      userId: 'user-1',
      project: 'Alpha',
      isSuperAdmin: false,
    });

    expect(result.incompletePipeline).toMatchObject({ status: 'error', data: null });
    expect(result.myWork).toMatchObject({ status: 'error', data: null });
    expect(result.openBugsOnPbis).toMatchObject({ status: 'error', data: null });
    expect(result.artifactCycleTime?.status).toBe('ok');
    expect(result.devToProduction?.status).toBe('ok');
  });

  it('TBI-001 DoD-2 / VT-10 contains menu and group lookup failures to their gated tiles', async () => {
    const deps = dependencies({
      getMenuConfig: jest.fn().mockRejectedValue(new Error('menu unavailable')),
      getUserGroupNames: jest.fn().mockRejectedValue(new Error('groups unavailable')),
    });

    const result = await createHomeDashboardService(deps).getDashboard({
      userId: 'user-1',
      project: 'Alpha',
      isSuperAdmin: false,
    });

    expect(result.incompletePipeline).toBeNull();
    expect(result.artifactCycleTime).toBeNull();
    expect(result.myWork).toBeNull();
    expect(result.openBugsOnPbis?.status).toBe('ok');
    expect(result.devToProduction?.status).toBe('ok');
    expect(deps.getIncompletePipeline).not.toHaveBeenCalled();
    expect(deps.getArtifactCycleTime).not.toHaveBeenCalled();
    expect(deps.getMyWorkSummary).not.toHaveBeenCalled();
  });

  it('PBI-004/005 AC-1 / VT-14 returns cached remote data after timeout and errors without cache', async () => {
    const deps = dependencies();
    const service = createHomeDashboardService(deps, {
      localTimeoutMs: 20,
      remoteTimeoutMs: 20,
    });
    const input = { userId: 'user-1', project: 'Alpha', isSuperAdmin: false };
    const first = await service.getDashboard(input);
    const cachedBugs = first.openBugsOnPbis?.data;

    (deps.getDefectRollup as jest.Mock).mockImplementation(() => new Promise(() => undefined));
    (deps.getDeliveryCycleTime as jest.Mock).mockRejectedValue(new Error('Releases unavailable'));
    const second = await service.getDashboard(input);

    expect(second.openBugsOnPbis).toMatchObject({
      status: 'error',
      data: null,
      lastKnownData: cachedBugs,
    });
    expect(second.devToProduction).toMatchObject({
      status: 'error',
      data: null,
      lastKnownData: first.devToProduction?.data,
    });

    const uncached = createHomeDashboardService(dependencies({
      getDefectRollup: jest.fn().mockRejectedValue(new Error('ADO unavailable')),
    }), { remoteTimeoutMs: 20 });
    const withoutCache = await uncached.getDashboard(input);
    expect(withoutCache.openBugsOnPbis).toMatchObject({
      status: 'error',
      data: null,
    });
    expect(withoutCache.openBugsOnPbis).not.toHaveProperty('lastKnownData');
  });

  it('PBI-005 NFR / VT-14 uses remote timeout for Apex Dev→Production even when My Work is local', async () => {
    jest.useFakeTimers();
    const localTimeoutMs = 50;
    const remoteTimeoutMs = 5_000;
    const deps = dependencies({
      getDeliveryCycleTime: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    });
    const service = createHomeDashboardService(deps, { localTimeoutMs, remoteTimeoutMs });

    try {
      let settled: Awaited<ReturnType<typeof service.getDashboard>> | undefined;
      const pending = service.getDashboard({
        userId: 'user-1',
        project: 'Apex',
        isSuperAdmin: false,
      }).then((payload) => {
        settled = payload;
        return payload;
      });

      await jest.advanceTimersByTimeAsync(localTimeoutMs + 1);
      expect(settled).toBeUndefined();

      await jest.advanceTimersByTimeAsync(remoteTimeoutMs - localTimeoutMs);
      const result = await pending;
      expect(result.devToProduction).toMatchObject({ status: 'error', data: null });
      expect(result.myWork?.status).toBe('ok');
    } finally {
      jest.useRealTimers();
    }
  });

  it('TBI-001 DoD-3 / VT-18 returns empty statuses for an authorized project with no qualifying data', async () => {
    const deps = dependencies({
      getIncompletePipeline: jest.fn().mockResolvedValue({
        groups: [],
        updatedAt: '2026-08-31T00:00:00.000Z',
      }),
      getArtifactCycleTime: jest.fn().mockResolvedValue({
        interview: { medianDays: null, sampleSize: 0, windowDays: 90 },
        prd: { medianDays: null, sampleSize: 0, windowDays: 90 },
        testCase: { medianDays: null, sampleSize: 0, windowDays: 90 },
        designDoc: { medianDays: null, sampleSize: 0, windowDays: 90 },
      }),
      getMyWorkSummary: jest.fn().mockResolvedValue({
        readyCount: 0,
        inProgressCount: 0,
        medianCompletionDays: null,
        sampleSize: 0,
      }),
      getDefectRollup: jest.fn().mockResolvedValue({
        projectOpenDefectCount: 0,
        pbiRows: [],
      }),
      getDeliveryCycleTime: jest.fn().mockResolvedValue({
        medianCycleTimeDays: null,
        releases: [],
      }),
    });

    const result = await createHomeDashboardService(deps).getDashboard({
      userId: 'user-1',
      project: 'Empty',
      isSuperAdmin: true,
    });

    expect(Object.values(result).map((tile) => tile?.status)).toEqual([
      'empty',
      'empty',
      'empty',
      'empty',
      'empty',
    ]);
  });
});
