import fs from 'fs';
import os from 'os';
import path from 'path';

const mockGit = jest.fn();

jest.mock('../utils/asyncGit', () => {
  const actual = jest.requireActual('../utils/asyncGit');
  return {
    ...actual,
    git: (...args: unknown[]) => mockGit(...args),
  };
});

type MaterializeFn =
  typeof import('../services/repoWorkspaceService').materializeWorkspaceFromCache;

async function loadMaterialize(): Promise<MaterializeFn> {
  // Re-import after jest.resetModules() so the module-level
  // `safeDirectoryConfigured` guard (in repoGitSettings) starts fresh.
  const mod = await import('../services/repoWorkspaceService');
  return mod.materializeWorkspaceFromCache;
}

describe('repoWorkspaceService Azure Files ownership handling', () => {
  const originalSiteName = process.env.WEBSITE_SITE_NAME;
  const originalInstanceId = process.env.WEBSITE_INSTANCE_ID;

  beforeEach(() => {
    jest.resetModules();
    mockGit.mockReset();
    mockGit.mockResolvedValue('');
    delete process.env.WEBSITE_SITE_NAME;
    delete process.env.WEBSITE_INSTANCE_ID;
  });

  afterAll(() => {
    if (originalSiteName === undefined) delete process.env.WEBSITE_SITE_NAME;
    else process.env.WEBSITE_SITE_NAME = originalSiteName;
    if (originalInstanceId === undefined) delete process.env.WEBSITE_INSTANCE_ID;
    else process.env.WEBSITE_INSTANCE_ID = originalInstanceId;
  });

  it('marks the bare cache as safe for the clone command', async () => {
    const materializeWorkspaceFromCache = await loadMaterialize();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-workspace-safe-'));
    const cacheDir = path.join(root, 'cache.git');
    const workspaceDir = path.join(root, 'workspace');

    try {
      // When (not on Azure — the global guard is a no-op)
      await materializeWorkspaceFromCache(
        cacheDir,
        workspaceDir,
        'main',
        'https://example.invalid/apex.git'
      );

      // Then the clone is the first git call and still carries the per-command
      // safe.directory override for the source mirror.
      expect(mockGit).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([
          '-c',
          `safe.directory=${cacheDir}`,
          'clone',
          cacheDir,
          workspaceDir,
        ]),
        expect.any(Object)
      );
      // No global safe.directory config is written off Azure.
      expect(
        mockGit.mock.calls.some(
          ([first]: unknown[]) => Array.isArray(first) && first[0] === 'config'
        )
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('trusts all repos at the global config level before cloning on Azure App Service', async () => {
    // Given the process looks like Azure App Service.
    process.env.WEBSITE_SITE_NAME = 'app-apex-prd';
    const materializeWorkspaceFromCache = await loadMaterialize();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-workspace-azure-'));
    const cacheDir = path.join(root, 'cache.git');
    const workspaceDir = path.join(root, 'workspace');

    try {
      // When
      await materializeWorkspaceFromCache(
        cacheDir,
        workspaceDir,
        'main',
        'https://example.invalid/apex.git'
      );

      // Then the very first git call trusts all repos globally, so the clone's
      // `--no-local` upload-pack transport also clears the dubious-ownership
      // guard (a per-command `-c safe.directory` does not reach that child).
      expect(mockGit).toHaveBeenNthCalledWith(1, [
        'config',
        '--system',
        '--add',
        'safe.directory',
        '*',
      ]);

      // And the clone still runs afterwards.
      const cloneCallIndex = mockGit.mock.calls.findIndex(
        ([first]: unknown[]) => Array.isArray(first) && first.includes('clone')
      );
      expect(cloneCallIndex).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
