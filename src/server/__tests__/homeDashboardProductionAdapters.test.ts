const mockDbSelect = jest.fn();
const mockQueryWorkItems = jest.fn();
const mockQueryLinks = jest.fn();
const mockRevisionHistory = jest.fn();
const mockRelatedItemsCycleTime = jest.fn();
const mockListDeployments = jest.fn();
const mockAzureDevOpsService = jest.fn().mockImplementation(() => ({
  queryWorkItemsByWiql: mockQueryWorkItems,
  queryWorkItemLinksByWiql: mockQueryLinks,
  getWorkItemRevisionHistory: mockRevisionHistory,
  getRelatedItemsCycleTime: mockRelatedItemsCycleTime,
}));

jest.mock('../db/drizzle', () => ({
  db: { select: mockDbSelect },
}));
jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: mockAzureDevOpsService,
}));
jest.mock('../services/apexDeploymentService', () => ({
  listDeployments: mockListDeployments,
}));

import { createProductionDefectRollupService } from '../services/defectRollupService';
import { createProductionDeliveryCycleTimeService } from '../services/deliveryCycleTimeService';
import { createProductionMyWorkSummaryService } from '../services/myWorkSummaryService';

function selectResult<T>(rows: T[]) {
  const result = Promise.resolve(rows);
  return {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue(result),
        orderBy: jest.fn().mockReturnValue(result),
      }),
    }),
  };
}

describe('home dashboard production adapters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('S5 adapter resolves the session user identity and queries assigned ADO work', async () => {
    mockDbSelect.mockReturnValue(selectResult([{
      email: 'developer@example.com',
      displayName: 'Developer One',
    }]));
    mockQueryWorkItems.mockResolvedValue({
      items: [{ id: 7, fields: { 'System.State': 'Active' } }],
    });

    const summary = await createProductionMyWorkSummaryService().getSummary({
      userId: 'user-7',
      project: 'External',
      scope: 'mine',
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(mockAzureDevOpsService).toHaveBeenCalledWith('External');
    expect(mockQueryWorkItems.mock.calls[0][0].wiql).toContain(
      "[System.AssignedTo] = 'developer@example.com'",
    );
    expect(mockQueryWorkItems.mock.calls[0][0].wiql).toContain(
      "[System.ChangedDate] >= '2026-06-02'",
    );
    expect(mockQueryWorkItems.mock.calls[0][0].wiql).not.toContain('2026-06-02T');
    expect(summary).toEqual({
      readyCount: 0,
      inProgressCount: 1,
      medianCompletionDays: null,
      sampleSize: 0,
    });
  });

  it('S6 adapter uses project-scoped ADO hierarchy links and hydrated work items', async () => {
    mockQueryLinks.mockResolvedValue([{ sourceId: 10, targetId: 11 }]);
    mockQueryWorkItems.mockResolvedValue({
      items: [
        {
          id: 10,
          fields: {
            'System.WorkItemType': 'Product Backlog Item',
            'System.Title': 'PBI',
            'System.ChangedDate': '2026-08-30T00:00:00.000Z',
          },
        },
        {
          id: 11,
          fields: {
            'System.WorkItemType': 'Bug',
            'System.State': 'Active',
          },
        },
      ],
    });

    const result = await createProductionDefectRollupService().getRollup({
      userId: 'user-1',
      project: "Team's Project",
      scope: 'team',
    });

    expect(mockAzureDevOpsService).toHaveBeenCalledWith("Team's Project");
    expect(mockQueryLinks.mock.calls[0][0]).toContain("Team''s Project");
    expect(result.projectOpenDefectCount).toBe(1);
  });

  it('bug-to-PBI ratio queries created PBIs and child bugs in the 90-day window', async () => {
    mockQueryWorkItems.mockResolvedValue({ ids: [1, 2, 3, 4, 5] });
    mockQueryLinks.mockResolvedValue([
      { sourceId: 1, targetId: 101 },
      { sourceId: 2, targetId: 102 },
    ]);

    const result = await createProductionDefectRollupService().getBugToPbiRatio({
      userId: 'user-1',
      project: 'MaxView',
      scope: 'team',
      now: new Date('2026-09-01T00:00:00.000Z'),
    });

    expect(mockQueryWorkItems.mock.calls[0][0].wiql).toContain("[System.CreatedDate] >= '2026-06-03'");
    expect(mockQueryLinks.mock.calls[0][0]).toContain("[Target].[System.CreatedDate] >= '2026-06-03'");
    expect(result).toEqual({
      bugCount: 2,
      pbiCount: 5,
      ratio: 0.4,
      windowDays: 90,
    });
  });

  it('S2 adapter combines ADO release tags and revisions with PG production deployments', async () => {
    mockQueryWorkItems.mockResolvedValue({
      items: [{
        id: 21,
        fields: { 'System.Tags': 'Release:2.0; apex' },
      }],
    });
    mockDbSelect.mockReturnValue(selectResult([]));
    mockRevisionHistory.mockResolvedValue([{
      state: 'In Progress',
      changedDate: '2026-08-01T00:00:00.000Z',
      fields: {},
    }]);
    mockListDeployments.mockResolvedValue([{
      environment: 'prod',
      version: '2.0',
      deployedAt: '2026-08-11T00:00:00.000Z',
    }]);

    const result = await createProductionDeliveryCycleTimeService().getCycleTime({
      project: 'External',
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(mockRevisionHistory).toHaveBeenCalledWith(21, 500);
    expect(mockQueryWorkItems.mock.calls[0][0].wiql).toContain(
      "[System.ChangedDate] >= '2026-06-02'",
    );
    expect(mockQueryWorkItems.mock.calls[0][0].wiql).not.toContain('2026-06-02T');
    expect(mockListDeployments).toHaveBeenCalledWith('External');
    expect(result.medianCycleTimeDays).toBe(10);
    expect(result.releases).toHaveLength(1);
  });

  it('uses completed related work under ReleaseVersion Epics when the project has no tagged items', async () => {
    mockQueryWorkItems
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [{
          id: 31,
          fields: {
            'System.Title': 'MV 2026.12.0',
            'System.State': 'Done',
            'System.ChangedDate': '2026-08-21T00:00:00.000Z',
            'Microsoft.VSTS.Scheduling.StartDate': '2026-08-01T00:00:00.000Z',
          },
        }],
      });
    mockRelatedItemsCycleTime.mockResolvedValue({
      items: [
        {
          id: 301,
          lastInProgressAt: '2026-08-01T00:00:00.000Z',
          lastDoneAt: '2026-08-11T00:00:00.000Z',
          cycleTimeDays: 10,
        },
        {
          id: 302,
          lastInProgressAt: '2026-08-02T00:00:00.000Z',
          lastDoneAt: '2026-08-22T00:00:00.000Z',
          cycleTimeDays: 20,
        },
        {
          id: 303,
          lastInProgressAt: '2026-08-03T00:00:00.000Z',
          lastDoneAt: null,
          cycleTimeDays: null,
        },
      ],
    });
    const result = await createProductionDeliveryCycleTimeService().getCycleTime({
      project: 'MaxView',
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(mockQueryWorkItems).toHaveBeenCalledTimes(2);
    expect(mockQueryWorkItems.mock.calls[1][0].wiql).toContain(
      "[System.Tags] CONTAINS 'ReleaseVersion'",
    );
    expect(mockListDeployments).not.toHaveBeenCalled();
    expect(mockRevisionHistory).not.toHaveBeenCalled();
    expect(mockRelatedItemsCycleTime).toHaveBeenCalledWith(31);
    expect(result.medianCycleTimeDays).toBe(15);
    expect(result.releases).toEqual([
      expect.objectContaining({ workItemId: 301, releaseName: 'MV 2026.12.0', cycleTimeDays: 10 }),
      expect.objectContaining({ workItemId: 302, releaseName: 'MV 2026.12.0', cycleTimeDays: 20 }),
    ]);
  });
});
