import { AzureDevOpsService } from '../services/azureDevOps';
import * as azdev from 'azure-devops-node-api';
import { retryWithBackoff } from '../utils/retry';

// Mock the retry utility
jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn((fn) => fn()),
}));

// Mock Azure DevOps Node API
jest.mock('azure-devops-node-api');

describe('AzureDevOpsService', () => {
  let mockConnection: any;
  let mockWitApi: any;
  let mockCoreApi: any;
  
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Set up environment variables
    process.env = {
      ...originalEnv,
      ADO_ORG: 'https://dev.azure.com/test-org',
      ADO_PAT: 'test-pat',
      ADO_PROJECT: 'TestProject',
      ADO_AREA_PATH: 'TestProject\\TestArea',
    };

    // Mock WIT API
    mockWitApi = {
      queryByWiql: jest.fn(),
      getWorkItems: jest.fn(),
      getRevisions: jest.fn(),
      updateWorkItem: jest.fn(),
      createWorkItem: jest.fn(),
    };

    // Mock Core API
    mockCoreApi = {
      getProject: jest.fn(),
    };

    // Mock Connection
    mockConnection = {
      getWorkItemTrackingApi: jest.fn().mockResolvedValue(mockWitApi),
      getCoreApi: jest.fn().mockResolvedValue(mockCoreApi),
    };

    // Mock WebApi constructor
    (azdev.WebApi as any) = jest.fn().mockReturnValue(mockConnection);
    (azdev.getPersonalAccessTokenHandler as any) = jest.fn();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should create service with environment variables', () => {
      const service = new AzureDevOpsService();
      expect(azdev.WebApi).toHaveBeenCalledWith(
        'https://dev.azure.com/test-org',
        undefined,
        expect.objectContaining({ socketTimeout: 120000 })
      );
    });

    it('should allow override of project and area path', () => {
      const service = new AzureDevOpsService('CustomProject', 'CustomProject\\CustomArea');
      expect(service).toBeDefined();
    });

    it('should throw error when required env variables are missing', () => {
      delete process.env.ADO_ORG;
      expect(() => new AzureDevOpsService()).toThrow(
        'Missing required environment variable: ADO_ORG must be provided'
      );
    });
  });

  describe('getWorkItems', () => {
    it('should fetch work items without date range', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.queryByWiql.mockResolvedValue({
        workItems: [{ id: 1 }, { id: 2 }],
      });

      mockWitApi.getWorkItems.mockResolvedValue([
        {
          id: 1,
          fields: {
            'System.Id': 1,
            'System.Title': 'Test Item 1',
            'System.State': 'New',
            'System.WorkItemType': 'Product Backlog Item',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
            'System.CreatedDate': '2024-01-01T00:00:00Z',
            'System.AreaPath': 'TestProject\\TestArea',
            'System.IterationPath': 'TestProject\\Sprint 1',
          },
        },
        {
          id: 2,
          fields: {
            'System.Id': 2,
            'System.Title': 'Test Item 2',
            'System.State': 'In Progress',
            'System.WorkItemType': 'Product Backlog Item',
            'System.ChangedDate': '2024-01-02T00:00:00Z',
            'System.CreatedDate': '2024-01-02T00:00:00Z',
            'System.AreaPath': 'TestProject\\TestArea',
            'System.IterationPath': 'TestProject\\Sprint 1',
            'System.AssignedTo': { displayName: 'John Doe' },
            'Microsoft.VSTS.Scheduling.DueDate': '2024-01-15T00:00:00Z',
          },
        },
      ]);

      const result = await service.getWorkItems();

      expect(mockWitApi.queryByWiql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("'TestProject'"),
        }),
        { project: 'TestProject' }
      );

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 1,
        title: 'Test Item 1',
        state: 'New',
        workItemType: 'Product Backlog Item',
      });
    });

    it('should fetch work items with date range filter', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.queryByWiql.mockResolvedValue({
        workItems: [{ id: 1 }],
      });

      mockWitApi.getWorkItems.mockResolvedValue([
        {
          id: 1,
          fields: {
            'System.Id': 1,
            'System.Title': 'Test Item',
            'System.State': 'New',
            'System.WorkItemType': 'Product Backlog Item',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
            'System.CreatedDate': '2024-01-01T00:00:00Z',
            'System.AreaPath': 'TestProject\\TestArea',
            'System.IterationPath': 'TestProject\\Sprint 1',
          },
        },
      ]);

      await service.getWorkItems('2024-01-01', '2024-01-31');

      expect(mockWitApi.queryByWiql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("'2024-01-01'"),
        }),
        { project: 'TestProject' }
      );
    });

    it('should return empty array when no work items found', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.queryByWiql.mockResolvedValue({
        workItems: [],
      });

      const result = await service.getWorkItems();
      expect(result).toEqual([]);
    });

    it('should handle work items in batches of 200', async () => {
      const service = new AzureDevOpsService();
      
      // Create 250 work item IDs
      const workItems = Array.from({ length: 250 }, (_, i) => ({ id: i + 1 }));
      
      mockWitApi.queryByWiql.mockResolvedValue({ workItems });
      mockWitApi.getWorkItems.mockResolvedValue([]);

      await service.getWorkItems();

      // Should be called 4 times (2 for fields: 200 + 50, and 2 for relations: 200 + 50)
      expect(mockWitApi.getWorkItems).toHaveBeenCalledTimes(4);
    });
  });

  describe('calculateCycleTime', () => {
    it('should calculate cycle time with valid state transitions', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockResolvedValue([
        {
          fields: {
            'System.State': 'New',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
          },
        },
        {
          fields: {
            'System.State': 'In Progress',
            'System.ChangedDate': '2024-01-05T00:00:00Z',
            'System.AssignedTo': { displayName: 'John Doe' },
          },
        },
        {
          fields: {
            'System.State': 'Ready For Test',
            'System.ChangedDate': '2024-01-10T00:00:00Z',
            'System.AssignedTo': { displayName: 'Jane Tester' },
          },
        },
        {
          fields: {
            'System.State': 'UAT - Ready For Test',
            'System.ChangedDate': '2024-01-12T00:00:00Z',
          },
        },
      ]);

      const result = await service.calculateCycleTime(1);

      expect(result).toBeDefined();
      expect(result?.inProgressDate).toBe('2024-01-05');
      expect(result?.qaReadyDate).toBe('2024-01-10');
      expect(result?.uatReadyDate).toBe('2024-01-12');
      expect(result?.cycleTimeDays).toBe(5);
      expect(result?.qaCycleTimeDays).toBe(2);
      expect(result?.assignedTo).toBe('John Doe');
      expect(result?.qaAssignedTo).toBe('Jane Tester');
    });

    it('should return undefined when no revisions exist', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockResolvedValue([]);

      const result = await service.calculateCycleTime(1);
      expect(result).toBeUndefined();
    });

    it('should return undefined on error', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockRejectedValue(new Error('API Error'));

      const result = await service.calculateCycleTime(1);
      expect(result).toBeUndefined();
    });
  });

  describe('updateDueDate', () => {
    it('should set due date with proper ISO format', async () => {
      const service = new AzureDevOpsService();

      await service.updateDueDate(1, '2024-03-15');

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'add',
            path: '/fields/Microsoft.VSTS.Scheduling.DueDate',
            value: expect.stringMatching(/2024-03-15/),
          }),
        ]),
        1,
        'TestProject'
      );
    });

    it('should remove due date when null is provided', async () => {
      const service = new AzureDevOpsService();

      await service.updateDueDate(1, null);

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'remove',
            path: '/fields/Microsoft.VSTS.Scheduling.DueDate',
          }),
        ]),
        1,
        'TestProject'
      );
    });

    it('should include reason in history when provided', async () => {
      const service = new AzureDevOpsService();

      await service.updateDueDate(1, '2024-03-15', 'Client request');

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'add',
            path: '/fields/System.History',
            value: 'Due date change reason: Client request',
          }),
        ]),
        1,
        'TestProject'
      );
    });
  });

  describe('updateWorkItemField', () => {
    it('should update field with friendly name mapping', async () => {
      const service = new AzureDevOpsService();

      await service.updateWorkItemField(1, 'state', 'In Progress');

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'add',
            path: '/fields/System.State',
            value: 'In Progress',
          }),
        ]),
        1,
        'TestProject'
      );
    });

    it('should remove field when value is null', async () => {
      const service = new AzureDevOpsService();

      await service.updateWorkItemField(1, 'assignedTo', null);

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'remove',
            path: '/fields/System.AssignedTo',
          }),
        ]),
        1,
        'TestProject'
      );
    });

    it('should use custom field name directly if not in mapping', async () => {
      const service = new AzureDevOpsService();

      await service.updateWorkItemField(1, 'Custom.MyField', 'test value');

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'add',
            path: '/fields/Custom.MyField',
            value: 'test value',
          }),
        ]),
        1,
        'TestProject'
      );
    });
  });

  describe('healthCheck', () => {
    it('should return true when connection is healthy', async () => {
      const service = new AzureDevOpsService();
      
      mockCoreApi.getProject.mockResolvedValue({ name: 'TestProject' });

      const result = await service.healthCheck();
      expect(result).toBe(true);
      expect(mockCoreApi.getProject).toHaveBeenCalledWith('TestProject');
    });

    it('should return false when connection fails', async () => {
      const service = new AzureDevOpsService();
      
      mockCoreApi.getProject.mockRejectedValue(new Error('Connection failed'));

      const result = await service.healthCheck();
      expect(result).toBe(false);
    });
  });

  describe('calculateCycleTimeForItems', () => {
    it('should calculate cycle time for multiple items in batches', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockResolvedValue([
        {
          fields: {
            'System.State': 'In Progress',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
          },
        },
        {
          fields: {
            'System.State': 'Ready For Test',
            'System.ChangedDate': '2024-01-05T00:00:00Z',
          },
        },
      ]);

      const result = await service.calculateCycleTimeForItems([1, 2, 3]);

      expect(result).toBeDefined();
      expect(Object.keys(result)).toHaveLength(3);
    });

    it('should handle items without cycle time data', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockResolvedValue([]);

      const result = await service.calculateCycleTimeForItems([1]);

      expect(result).toEqual({});
    });
  });

  describe('getDueDateChangeHistory', () => {
    it('should extract due date changes from revisions', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockResolvedValue([
        {
          fields: {
            'Microsoft.VSTS.Scheduling.DueDate': '2024-01-10T00:00:00Z',
            'System.ChangedBy': { displayName: 'John Doe' },
            'System.ChangedDate': '2024-01-01T00:00:00Z',
          },
        },
        {
          fields: {
            'Microsoft.VSTS.Scheduling.DueDate': '2024-01-15T00:00:00Z',
            'System.ChangedBy': { displayName: 'Jane Smith' },
            'System.ChangedDate': '2024-01-02T00:00:00Z',
            'System.History': 'Due date change reason: Client request',
          },
        },
      ]);

      const result = await service.getDueDateChangeHistory([1]);

      expect(result).toHaveLength(2);
      // First change: undefined -> 2024-01-10
      expect(result[0]).toMatchObject({
        changedBy: 'John Doe',
        oldDueDate: undefined,
        newDueDate: '2024-01-10',
      });
      // Second change: 2024-01-10 -> 2024-01-15
      expect(result[1]).toMatchObject({
        changedBy: 'Jane Smith',
        oldDueDate: '2024-01-10',
        newDueDate: '2024-01-15',
        reason: 'Client request',
      });
    });

    it('should handle items with no revisions', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockResolvedValue([]);

      const result = await service.getDueDateChangeHistory([1]);

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.getRevisions.mockRejectedValue(new Error('API Error'));

      const result = await service.getDueDateChangeHistory([1]);

      expect(result).toEqual([]);
    });
  });

  describe('getEpicChildren', () => {
    it('should fetch child PBIs from epic hierarchy', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.queryByWiql.mockResolvedValue({
        workItemRelations: [
          { target: { id: 100 } }, // Epic itself
          { target: { id: 101 } }, // Feature
          { target: { id: 102 } }, // PBI
        ],
      });

      mockWitApi.getWorkItems.mockResolvedValue([
        {
          id: 101,
          fields: {
            'System.Id': 101,
            'System.Title': 'Feature',
            'System.WorkItemType': 'Feature',
            'System.State': 'New',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
            'System.CreatedDate': '2024-01-01T00:00:00Z',
            'System.AreaPath': 'TestProject\\TestArea',
            'System.IterationPath': 'TestProject\\Sprint 1',
          },
        },
        {
          id: 102,
          fields: {
            'System.Id': 102,
            'System.Title': 'PBI',
            'System.WorkItemType': 'Product Backlog Item',
            'System.State': 'New',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
            'System.CreatedDate': '2024-01-01T00:00:00Z',
            'System.AreaPath': 'TestProject\\TestArea',
            'System.IterationPath': 'TestProject\\Sprint 1',
          },
        },
      ]);

      const result = await service.getEpicChildren(100);

      expect(result).toHaveLength(1); // Only Feature, PBI filtered out
      expect(result[0].workItemType).toBe('Feature');
    });

    it('should return empty array when epic has no children', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.queryByWiql.mockResolvedValue({
        workItemRelations: [],
      });

      const result = await service.getEpicChildren(100);
      expect(result).toEqual([]);
    });
  });

  describe('QA Complete Date', () => {
    it('should fetch work items with qaCompleteDate field', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.queryByWiql.mockResolvedValue({
        workItems: [{ id: 1 }],
      });

      // Create a date at noon to avoid timezone issues in tests
      const testDate = new Date(2024, 0, 20, 12, 0, 0); // Jan 20, 2024 at noon

      mockWitApi.getWorkItems.mockResolvedValue([
        {
          id: 1,
          fields: {
            'System.Id': 1,
            'System.Title': 'Test Item',
            'System.State': 'Ready For Test',
            'System.WorkItemType': 'Product Backlog Item',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
            'System.CreatedDate': '2024-01-01T00:00:00Z',
            'System.AreaPath': 'TestProject\\TestArea',
            'System.IterationPath': 'TestProject\\Sprint 1',
            'Custom.QACompleteDate': testDate.toISOString(),
          },
        },
      ]);

      const result = await service.getWorkItems();

      expect(result).toHaveLength(1);
      expect(result[0].qaCompleteDate).toBe('2024-01-20');
    });

    it('should handle work items without qaCompleteDate', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.queryByWiql.mockResolvedValue({
        workItems: [{ id: 1 }],
      });

      mockWitApi.getWorkItems.mockResolvedValue([
        {
          id: 1,
          fields: {
            'System.Id': 1,
            'System.Title': 'Test Item',
            'System.State': 'New',
            'System.WorkItemType': 'Product Backlog Item',
            'System.ChangedDate': '2024-01-01T00:00:00Z',
            'System.CreatedDate': '2024-01-01T00:00:00Z',
            'System.AreaPath': 'TestProject\\TestArea',
            'System.IterationPath': 'TestProject\\Sprint 1',
          },
        },
      ]);

      const result = await service.getWorkItems();

      expect(result).toHaveLength(1);
      expect(result[0].qaCompleteDate).toBeUndefined();
    });

    it('should update qaCompleteDate field via updateWorkItemField', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.updateWorkItem.mockResolvedValue({});

      await service.updateWorkItemField(123, 'qaCompleteDate', '2024-01-25');

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'add',
            path: '/fields/Custom.QACompleteDate',
            value: expect.stringContaining('2024-01-25'),
          }),
        ]),
        123,
        'TestProject'
      );
    });

    it('should convert qaCompleteDate to ISO string when updating', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.updateWorkItem.mockResolvedValue({});

      await service.updateWorkItemField(123, 'qaCompleteDate', '2024-01-25');

      const callArgs = mockWitApi.updateWorkItem.mock.calls[0];
      const patchDoc = callArgs[1];
      const addOperation = patchDoc.find((op: any) => op.path === '/fields/Custom.QACompleteDate');
      
      expect(addOperation).toBeDefined();
      expect(addOperation.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should remove qaCompleteDate when value is undefined', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.updateWorkItem.mockResolvedValue({});

      await service.updateWorkItemField(123, 'qaCompleteDate', undefined);

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'remove',
            path: '/fields/Custom.QACompleteDate',
          }),
        ]),
        123,
        'TestProject'
      );
    });

    it('should remove qaCompleteDate when value is empty string', async () => {
      const service = new AzureDevOpsService();
      
      mockWitApi.updateWorkItem.mockResolvedValue({});

      await service.updateWorkItemField(123, 'qaCompleteDate', '');

      expect(mockWitApi.updateWorkItem).toHaveBeenCalledWith(
        {},
        expect.arrayContaining([
          expect.objectContaining({
            op: 'remove',
            path: '/fields/Custom.QACompleteDate',
          }),
        ]),
        123,
        'TestProject'
      );
    });
  });

  describe('getWorkItemsAssignedToUser', () => {
    it('queries active Features, PBIs, TBIs, and Bugs assigned to the user', async () => {
      const service = new AzureDevOpsService('MaxView');

      mockWitApi.queryByWiql.mockResolvedValue({
        workItems: [{ id: 101 }, { id: 102 }],
      });

      mockWitApi.getWorkItems.mockResolvedValue([
        {
          id: 101,
          fields: {
            'System.Title': 'Login feature',
            'System.WorkItemType': 'Feature',
            'System.State': 'In Progress',
            'System.AssignedTo': { uniqueName: 'jane@example.com' },
            'System.AreaPath': 'MaxView\\Team',
            'System.IterationPath': 'MaxView\\Sprint 1',
            'System.Tags': 'apex; wave-1',
          },
        },
        {
          id: 102,
          fields: {
            'System.Title': 'Fix crash',
            'System.WorkItemType': 'Bug',
            'System.State': 'New',
            'System.AssignedTo': { uniqueName: 'jane@example.com' },
          },
        },
      ]);

      const result = await service.getWorkItemsAssignedToUser('Jane Developer', 'MaxView');

      expect(mockWitApi.queryByWiql).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("[System.AssignedTo] = 'Jane Developer'"),
        }),
        { project: 'MaxView' },
      );

      const wiql = mockWitApi.queryByWiql.mock.calls[0][0].query as string;
      expect(wiql).toContain("[System.WorkItemType] IN ('Feature', 'Product Backlog Item', 'Technical Backlog Item', 'Bug')");
      expect(wiql).toContain("[System.State] NOT IN ('Done', 'Closed', 'Removed')");

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 101,
        title: 'Login feature',
        workItemType: 'Feature',
        state: 'In Progress',
        assignedTo: 'jane@example.com',
        project: 'MaxView',
        areaPath: 'MaxView\\Team',
        iterationPath: 'MaxView\\Sprint 1',
        tags: 'apex; wave-1',
      });
      expect(result[1]).toMatchObject({
        id: 102,
        title: 'Fix crash',
        workItemType: 'Bug',
      });
    });

    it('escapes single quotes in display names', async () => {
      const service = new AzureDevOpsService('MaxView');

      mockWitApi.queryByWiql.mockResolvedValue({ workItems: [] });

      await service.getWorkItemsAssignedToUser("O'Brien", 'MaxView');

      const wiql = mockWitApi.queryByWiql.mock.calls[0][0].query as string;
      expect(wiql).toContain("[System.AssignedTo] = 'O''Brien'");
    });

    it('omits active-state filter when activeOnly is false', async () => {
      const service = new AzureDevOpsService('MaxView');

      mockWitApi.queryByWiql.mockResolvedValue({ workItems: [] });

      await service.getWorkItemsAssignedToUser('Jane Developer', 'MaxView', { activeOnly: false });

      const wiql = mockWitApi.queryByWiql.mock.calls[0][0].query as string;
      expect(wiql).not.toContain("[System.State] NOT IN");
    });
  });

  describe('createWorkItemForPrd — APEX origin tagging', () => {
    function tagsFromLastCreate(): string | undefined {
      const patch = mockWitApi.createWorkItem.mock.calls[0][1] as Array<{ path: string; value: unknown }>;
      const tagOp = patch.find((op) => op.path === '/fields/System.Tags');
      return tagOp?.value as string | undefined;
    }

    it('stamps the apex tag on a created Feature', async () => {
      const service = new AzureDevOpsService('MaxView');
      mockWitApi.createWorkItem.mockResolvedValue({ id: 501 });

      await service.createWorkItemForPrd({ type: 'Feature', title: 'Shift scheduler' });

      const tags = tagsFromLastCreate();
      expect(tags).toBeDefined();
      expect(tags!.split(';').map((t) => t.trim())).toContain('apex');
    });

    it('merges apex with caller-supplied tags without duplicating it', async () => {
      const service = new AzureDevOpsService('MaxView');
      mockWitApi.createWorkItem.mockResolvedValue({ id: 502 });

      await service.createWorkItemForPrd({ type: 'Feature', title: 'Shift scheduler', tags: ['wave-1', 'apex'] });

      const tags = (tagsFromLastCreate() ?? '').split(';').map((t) => t.trim());
      expect(tags).toContain('apex');
      expect(tags).toContain('wave-1');
      expect(tags.filter((t) => t === 'apex')).toHaveLength(1);
    });

    it('does not add the apex tag to non-Feature types', async () => {
      const service = new AzureDevOpsService('MaxView');
      mockWitApi.createWorkItem.mockResolvedValue({ id: 503 });

      await service.createWorkItemForPrd({ type: 'Product Backlog Item', title: 'A PBI' });

      // No tags provided and not a Feature → no System.Tags op at all.
      expect(tagsFromLastCreate()).toBeUndefined();
    });
  });
});
