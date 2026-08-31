const mockDbSelect = jest.fn();
const mockQueryWorkItems = jest.fn();
const mockQueryLinks = jest.fn();
const mockRevisionHistory = jest.fn();
const mockListDeployments = jest.fn();
const mockAzureDevOpsService = jest.fn().mockImplementation(() => ({
  queryWorkItemsByWiql: mockQueryWorkItems,
  queryWorkItemLinksByWiql: mockQueryLinks,
  getWorkItemRevisionHistory: mockRevisionHistory,
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
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(mockAzureDevOpsService).toHaveBeenCalledWith('External');
    expect(mockQueryWorkItems.mock.calls[0][0].wiql).toContain(
      "[System.AssignedTo] = 'developer@example.com'",
    );
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
      project: "Team's Project",
    });

    expect(mockAzureDevOpsService).toHaveBeenCalledWith("Team's Project");
    expect(mockQueryLinks.mock.calls[0][0]).toContain("Team''s Project");
    expect(result.projectOpenDefectCount).toBe(1);
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
    expect(mockListDeployments).toHaveBeenCalledWith('External');
    expect(result.medianCycleTimeDays).toBe(10);
    expect(result.releases).toHaveLength(1);
  });
});
