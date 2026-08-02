import type { RepositoryIdentity } from '../../shared/types/repoReader';
import { RemoteCatalogReader } from '../services/remoteCatalogReader';
import { RepoReaderError } from '../services/repoReader';

const identity: RepositoryIdentity = {
  provider: 'github',
  project: 'Apex',
  repo: 'AI-Pilot',
  sha: 'main',
};

describe('TBI-008 DoD-3 final remote-search convergence', () => {
  it('keeps remote read/list available while rejecting broad search without invoking it', async () => {
    // Arrange
    const catalog = {
      getSkillFile: jest.fn().mockResolvedValue('content'),
      listRepoDir: jest
        .fn()
        .mockResolvedValue([{ path: '/src', name: 'src', isFolder: true }]),
      searchRepoCode: jest.fn().mockResolvedValue([]),
    };
    const isConvergenceEnabled = jest.fn().mockResolvedValue(true);
    const reader = new RemoteCatalogReader(identity, catalog, {
      flagContext: {
        userId: 'user-1',
        project: 'Apex',
        caller: 'interview',
      },
      isConvergenceEnabled,
    });

    // Act
    const content = await reader.readFile('/README.md');
    const entries = await reader.listDir('/');
    const search = reader.searchCode('needle');

    // Assert
    expect(content).toBe('content');
    expect(entries).toHaveLength(1);
    await expect(search).rejects.toEqual(
      expect.objectContaining<Partial<RepoReaderError>>({
        code: 'REMOTE_SEARCH_DISABLED',
        fallbackEligible: false,
      })
    );
    expect(isConvergenceEnabled).toHaveBeenCalledWith({
      userId: 'user-1',
      project: 'Apex',
      caller: 'interview',
    });
    expect(catalog.searchRepoCode).not.toHaveBeenCalled();
  });

  it('retains broad remote search before convergence', async () => {
    // Arrange
    const catalog = {
      getSkillFile: jest.fn(),
      listRepoDir: jest.fn(),
      searchRepoCode: jest.fn().mockResolvedValue([{ path: '/src/a.ts' }]),
    };
    const reader = new RemoteCatalogReader(identity, catalog, {
      flagContext: {
        userId: 'user-1',
        project: 'Apex',
        caller: 'interview',
      },
      isConvergenceEnabled: jest.fn().mockResolvedValue(false),
    });

    // Act
    const result = await reader.searchCode('needle', 5);

    // Assert
    expect(result).toEqual([{ path: '/src/a.ts' }]);
    expect(catalog.searchRepoCode).toHaveBeenCalledTimes(1);
  });
});
