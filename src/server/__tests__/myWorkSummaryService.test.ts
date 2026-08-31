import { MyWorkSummaryService } from '../services/myWorkSummaryService';

describe('MyWorkSummaryService', () => {
  const now = new Date('2026-08-31T12:00:00.000Z');

  test('PBI-003 AC-0 VT-09 returns self/project counts and 90-day median for Apex-native work', async () => {
    const service = new MyWorkSummaryService({
      listNativeFeatures: jest.fn().mockResolvedValue([
        { featureId: 'ready', prdId: 'p1', dependsOn: [], readyAt: '2026-08-01T00:00:00Z' },
        { featureId: 'active', prdId: 'p1', dependsOn: [], readyAt: '2026-08-01T00:00:00Z' },
        { featureId: 'done-1', prdId: 'p1', dependsOn: [], readyAt: '2026-08-01T00:00:00Z' },
        { featureId: 'done-2', prdId: 'p1', dependsOn: [], readyAt: '2026-08-01T00:00:00Z' },
      ]),
      listDevSessions: jest.fn().mockResolvedValue([
        { id: 's1', featureId: 'active', prdId: 'p1', status: 'in_progress', createdAt: '2026-08-10T00:00:00Z', updatedAt: '2026-08-10T00:00:00Z' },
        { id: 's2', featureId: 'done-1', prdId: 'p1', status: 'completed', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z' },
        { id: 's3', featureId: 'done-2', prdId: 'p1', status: 'completed', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-21T00:00:00Z' },
      ]),
      listAdoWork: jest.fn(),
    });

    await expect(service.getSummary({ userId: 'me', project: 'Apex', now })).resolves.toEqual({
      readyCount: 1,
      inProgressCount: 1,
      medianCompletionDays: 15,
      sampleSize: 2,
    });
    expect(service.dependencies.listNativeFeatures).toHaveBeenCalledWith({ userId: 'me', project: 'Apex' });
  });

  test('PBI-003 AC-0 VT-11 maps ADO Ready/In Progress/done states and computes median', async () => {
    const service = new MyWorkSummaryService({
      listNativeFeatures: jest.fn(),
      listDevSessions: jest.fn(),
      listAdoWork: jest.fn().mockResolvedValue([
        { id: 1, state: 'New' },
        { id: 2, state: 'Active' },
        { id: 3, state: 'Closed', startedAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-05T00:00:00Z' },
        { id: 4, state: 'Done', startedAt: '2026-08-01T00:00:00Z', completedAt: '2026-08-07T00:00:00Z' },
      ]),
    });

    await expect(service.getSummary({ userId: 'me', project: 'Other', now })).resolves.toEqual({
      readyCount: 1,
      inProgressCount: 1,
      medianCompletionDays: 5,
      sampleSize: 2,
    });
    expect(service.dependencies.listAdoWork).toHaveBeenCalledWith({ userId: 'me', project: 'Other', since: '2026-06-02T12:00:00.000Z' });
  });

  test('PBI-003 AC-2 VT-24 keeps counts and returns null when there are no completions', async () => {
    const service = new MyWorkSummaryService({
      listNativeFeatures: jest.fn().mockResolvedValue([
        { featureId: 'ready', prdId: 'p1', dependsOn: [] },
      ]),
      listDevSessions: jest.fn().mockResolvedValue([]),
      listAdoWork: jest.fn(),
    });

    await expect(service.getSummary({ userId: 'me', project: 'Amego', now })).resolves.toEqual({
      readyCount: 1,
      inProgressCount: 0,
      medianCompletionDays: null,
      sampleSize: 0,
    });
  });
});
