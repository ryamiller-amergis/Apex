import { DeliveryCycleTimeService } from '../services/deliveryCycleTimeService';

describe('DeliveryCycleTimeService', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');

  test('TBI-003 PBI-005 AC-0 VT-17 uses first dev start and linked production release deployment', async () => {
    const deployments = {
      '1.0': { production: { deployedAt: '2026-08-11T00:00:00Z' } },
      '2.0': { production: { deployedAt: '2026-08-21T00:00:00Z' } },
    };
    const service = new DeliveryCycleTimeService({
      listDeliveryItems: jest.fn().mockResolvedValue([
        { id: 'a', releaseTags: ['Release:1.0'], nativeDevStartedAt: '2026-08-01T00:00:00Z' },
        { id: 'b', releaseTags: ['Release:2.0'], adoFirstInProgressAt: '2026-08-01T00:00:00Z' },
      ]),
      getLatestDeploymentsByRelease: jest.fn((name: string) => Promise.resolve(deployments[name as keyof typeof deployments])),
    });

    await expect(service.getCycleTime({ project: 'Apex', now })).resolves.toEqual({
      medianCycleTimeDays: 15,
      releases: [
        { workItemId: 'a', releaseName: '1.0', devStartedAt: '2026-08-01T00:00:00.000Z', productionDeployedAt: '2026-08-11T00:00:00.000Z', cycleTimeDays: 10 },
        { workItemId: 'b', releaseName: '2.0', devStartedAt: '2026-08-01T00:00:00.000Z', productionDeployedAt: '2026-08-21T00:00:00.000Z', cycleTimeDays: 20 },
      ],
    });
  });

  test('TBI-003 VT-19 excludes Dev/Staging-only, unlinked, and outside trailing 90-day window', async () => {
    const service = new DeliveryCycleTimeService({
      listDeliveryItems: jest.fn().mockResolvedValue([
        { id: 1, releaseTags: ['Release:dev'], adoFirstInProgressAt: '2026-08-01T00:00:00Z' },
        { id: 2, releaseTags: [], adoFirstInProgressAt: '2026-08-01T00:00:00Z' },
        { id: 3, releaseTags: ['Release:old'], adoFirstInProgressAt: '2026-01-01T00:00:00Z' },
      ]),
      getLatestDeploymentsByRelease: jest.fn(async (name: string) =>
        name === 'dev'
          ? { dev: { deployedAt: '2026-08-02T00:00:00Z' }, staging: { deployedAt: '2026-08-03T00:00:00Z' } }
          : { production: { deployedAt: '2026-02-01T00:00:00Z' } },
      ),
    });

    await expect(service.getCycleTime({ project: 'Apex', now })).resolves.toEqual({
      medianCycleTimeDays: null,
      releases: [],
    });
  });

  test('TBI-003 PBI-005 AC-2 VT-22 returns explicit null median for empty data', async () => {
    const service = new DeliveryCycleTimeService({
      listDeliveryItems: jest.fn().mockResolvedValue([]),
      getLatestDeploymentsByRelease: jest.fn(),
    });

    await expect(service.getCycleTime({ project: 'Apex', now })).resolves.toEqual({
      medianCycleTimeDays: null,
      releases: [],
    });
  });
});
