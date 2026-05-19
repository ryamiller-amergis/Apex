import { AzureDevOpsService } from '../services/azureDevOps';
import * as azdev from 'azure-devops-node-api';
import { retryWithBackoff } from '../utils/retry';

// Mock the retry utility
jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn((fn) => fn()),
}));

// Mock azure-devops-node-api
jest.mock('azure-devops-node-api');

describe('AzureDevOpsService - Delete Operations', () => {
  let service: AzureDevOpsService;
  let mockConnection: any;
  let mockWitApi: any;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set environment variables FIRST
    process.env = {
      ...originalEnv,
      ADO_ORG: 'https://dev.azure.com/testorg',
      ADO_PAT: 'test-pat-token',
      ADO_PROJECT: 'TestProject',
      ADO_AREA_PATH: 'TestArea',
    };

    // Mock Work Item Tracking API
    mockWitApi = {
      deleteWorkItem: jest.fn(),
      queryByWiql: jest.fn(),
      getWorkItems: jest.fn(),
    };

    // Mock connection
    mockConnection = {
      getWorkItemTrackingApi: jest.fn().mockResolvedValue(mockWitApi),
    };

    // Mock WebApi constructor
    (azdev.WebApi as any) = jest.fn().mockReturnValue(mockConnection);
    (azdev.getPersonalAccessTokenHandler as any) = jest.fn();

    // Now create service after env vars are set
    service = new AzureDevOpsService('TestProject', 'TestArea');
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('deleteWorkItem', () => {
    it('should successfully delete a work item', async () => {
      const workItemId = 123;
      mockWitApi.deleteWorkItem.mockResolvedValue(undefined);

      await service.deleteWorkItem(workItemId);

      expect(mockWitApi.deleteWorkItem).toHaveBeenCalledWith(workItemId, 'TestProject');
    });

    it('should handle deletion errors', async () => {
      const workItemId = 456;
      const error = new Error('Work item not found');
      mockWitApi.deleteWorkItem.mockRejectedValue(error);

      await expect(service.deleteWorkItem(workItemId)).rejects.toThrow('Work item not found');
      expect(mockWitApi.deleteWorkItem).toHaveBeenCalledWith(workItemId, 'TestProject');
    });

    it('should retry on transient failures', async () => {
      const workItemId = 789;
      
      // Mock retryWithBackoff to actually retry with transient errors
      const mockRetryWithBackoff = jest.requireActual('../utils/retry').retryWithBackoff;
      (retryWithBackoff as jest.Mock).mockImplementation(mockRetryWithBackoff);
      
      // Fail with transient errors (need statusCode for retry logic)
      const transientError1 = new Error('Transient error') as any;
      transientError1.statusCode = 503;
      const transientError2 = new Error('Transient error') as any;
      transientError2.statusCode = 500;
      
      mockWitApi.deleteWorkItem
        .mockRejectedValueOnce(transientError1)
        .mockRejectedValueOnce(transientError2)
        .mockResolvedValueOnce(undefined);

      await service.deleteWorkItem(workItemId);

      expect(mockWitApi.deleteWorkItem).toHaveBeenCalledTimes(3);
      
      // Restore the original mock that just calls fn()
      (retryWithBackoff as jest.Mock).mockImplementation((fn: any) => fn());
    });

    it('should delete work item with different project', async () => {
      const serviceWithCustomProject = new AzureDevOpsService('CustomProject', 'CustomArea');
      const workItemId = 999;
      mockWitApi.deleteWorkItem.mockResolvedValue(undefined);

      await serviceWithCustomProject.deleteWorkItem(workItemId);

      expect(mockWitApi.deleteWorkItem).toHaveBeenCalledWith(workItemId, 'CustomProject');
    });

    it('should handle permission errors', async () => {
      const workItemId = 111;
      const permissionError = new Error('Access denied');
      mockWitApi.deleteWorkItem.mockRejectedValue(permissionError);

      await expect(service.deleteWorkItem(workItemId)).rejects.toThrow('Access denied');
    });
  });

  describe('getReleaseVersions', () => {
    it('should extract release versions from tags', async () => {
      const mockWorkItems = [
        {
          id: 1,
          fields: {
            'System.Tags': 'Release:v1.0.0; Bug; Priority:High',
          },
        },
        {
          id: 2,
          fields: {
            'System.Tags': 'Release:v2.0.0; Feature',
          },
        },
        {
          id: 3,
          fields: {
            'System.Tags': 'Release:v1.0.0; Enhancement',
          },
        },
      ];

      mockWitApi.queryByWiql = jest.fn().mockResolvedValue({
        workItems: [{ id: 1 }, { id: 2 }, { id: 3 }],
      });
      mockWitApi.getWorkItems = jest.fn().mockResolvedValue(mockWorkItems);

      const versions = await service.getReleaseVersions();

      expect(versions).toEqual(['v1.0.0', 'v2.0.0']);
      expect(versions).toHaveLength(2); // Should deduplicate
    });

    it('should fetch release version work items in batches of 200', async () => {
      const queriedWorkItems = Array.from({ length: 246 }, (_, index) => ({ id: index + 1 }));

      mockWitApi.queryByWiql = jest.fn().mockResolvedValue({
        workItems: queriedWorkItems,
      });
      mockWitApi.getWorkItems = jest.fn().mockImplementation((ids: number[]) => Promise.resolve(
        ids.map((id) => ({
          id,
          fields: {
            'System.Tags': id <= 200 ? 'Release:v1.0.0' : 'Release:v2.0.0',
          },
        })),
      ));

      const versions = await service.getReleaseVersions();

      expect(versions).toEqual(['v1.0.0', 'v2.0.0']);
      expect(mockWitApi.getWorkItems).toHaveBeenCalledTimes(2);
      expect(mockWitApi.getWorkItems.mock.calls[0][0]).toHaveLength(200);
      expect(mockWitApi.getWorkItems.mock.calls[1][0]).toHaveLength(46);
      expect(mockWitApi.getWorkItems.mock.calls[0][1]).toEqual(['System.Tags']);
    });

    it('should return empty array when no release tags found', async () => {
      mockWitApi.queryByWiql = jest.fn().mockResolvedValue({
        workItems: [],
      });

      const versions = await service.getReleaseVersions();

      expect(versions).toEqual([]);
    });

    it('should handle work items without tags', async () => {
      const mockWorkItems = [
        {
          id: 1,
          fields: {},
        },
      ];

      mockWitApi.queryByWiql = jest.fn().mockResolvedValue({
        workItems: [{ id: 1 }],
      });
      mockWitApi.getWorkItems = jest.fn().mockResolvedValue(mockWorkItems);

      const versions = await service.getReleaseVersions();

      expect(versions).toEqual([]);
    });
  });
});
