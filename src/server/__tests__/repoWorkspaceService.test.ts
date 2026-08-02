import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../utils/asyncGit', () => {
  const actual = jest.requireActual('../utils/asyncGit');
  return {
    ...actual,
    git: jest.fn().mockResolvedValue(''),
  };
});

import { git } from '../utils/asyncGit';
import { materializeWorkspaceFromCache } from '../services/repoWorkspaceService';

describe('repoWorkspaceService Azure Files ownership handling', () => {
  it('marks the bare cache as safe for the clone command', async () => {
    // Given
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-workspace-safe-'));
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

      // Then
      expect(git).toHaveBeenNthCalledWith(
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
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
