jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
  },
}));

jest.mock('../services/azureDevOps', () => ({
  AzureDevOpsService: jest.fn(),
}));

import { AzureDevOpsService } from '../services/azureDevOps';
import {
  filterProjectCatalogByNames,
  listProjectCatalog,
} from '../services/projectCatalogService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const mockGetProjects = jest.fn();

function mockProjectReferenceRows(...rowSets: Array<Array<{ project: string | null }>>) {
  let index = 0;
  mockDb.select.mockImplementation(() => ({
    from: jest.fn().mockResolvedValue(rowSets[index++] ?? []),
  }));
}

describe('projectCatalogService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AzureDevOpsService as jest.Mock).mockImplementation(() => ({
      getProjects: mockGetProjects,
    }));
  });

  describe('listProjectCatalog', () => {
    it('returns all ADO, virtual, and DB-referenced projects without applying the legacy allowlist', async () => {
      mockGetProjects.mockResolvedValue([
        { id: 'ado-zebra', name: 'Zebra', description: 'ADO project beyond the legacy allowlist' },
        { id: 'ado-maxview', name: 'MaxView', description: 'MaxView project' },
        { id: 'ado-matterworx', name: 'MatterWorx', description: 'MatterWorx project' },
      ]);
      mockProjectReferenceRows(
        [{ project: 'Customer Portal' }],
        [{ project: 'Menu Only' }],
        [{ project: 'zebra' }],
        [{ project: null }, { project: 'Apex' }],
      );

      const result = await listProjectCatalog();

      expect(result.map((project) => project.name)).toEqual([
        'Apex',
        'Customer Portal',
        'MatterWorx',
        'MaxView',
        'Menu Only',
        'Zebra',
      ]);
      expect(result.find((project) => project.name === 'Zebra')).toMatchObject({
        id: 'ado-zebra',
        description: 'ADO project beyond the legacy allowlist',
      });
      expect(result.find((project) => project.name === 'Apex')).toMatchObject({
        id: 'apex-virtual',
      });
    });
  });

  describe('filterProjectCatalogByNames', () => {
    it('keeps assigned non-ADO projects visible even when they are missing from ADO', () => {
      const result = filterProjectCatalogByNames(
        [{ id: 'ado-maxview', name: 'MaxView', description: 'MaxView project' }],
        ['Apex', 'MaxView'],
      );

      expect(result).toEqual([
        {
          id: 'apex-virtual',
          name: 'Apex',
          description: 'AI Pilot self-development - requirement flows & orchestration',
        },
        { id: 'ado-maxview', name: 'MaxView', description: 'MaxView project' },
      ]);
    });
  });
});
