/**
 * Unit tests for repoCheckoutService — workspace paths and checkout guards.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

jest.mock('fs');
jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));
jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: jest.fn(() => '/data'),
}));

import {
  getWorkspaceDir,
  cleanupWorkspace,
  checkoutDefaultBranch,
  createFeatureBranch,
} from '../services/repoCheckoutService';

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockFs = fs as jest.Mocked<typeof fs>;

function workspacePath(sessionId: string): string {
  return path.join('/data', 'dev-workspaces', sessionId);
}

describe('repoCheckoutService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getWorkspaceDir', () => {
    it('returns path under dev-workspaces for the session id', () => {
      expect(getWorkspaceDir('session-123')).toBe(workspacePath('session-123'));
    });
  });

  describe('cleanupWorkspace', () => {
    it('removes the workspace directory when it exists', () => {
      mockFs.existsSync.mockReturnValue(true);

      cleanupWorkspace('session-123');

      expect(mockFs.rmSync).toHaveBeenCalledWith(workspacePath('session-123'), {
        recursive: true,
        force: true,
      });
    });

    it('does nothing when the workspace directory is missing', () => {
      mockFs.existsSync.mockReturnValue(false);

      cleanupWorkspace('session-123');

      expect(mockFs.rmSync).not.toHaveBeenCalled();
    });
  });

  describe('checkoutDefaultBranch', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('throws when ADO credentials are not configured', async () => {
      delete process.env.ADO_ORG;
      delete process.env.ADO_PAT;

      await expect(
        checkoutDefaultBranch({
          project: 'MaxView',
          repo: 'MaxView',
          branch: 'main',
          sessionId: 'session-123',
        }),
      ).rejects.toThrow('ADO_ORG and ADO_PAT must be set for repo checkout');
    });

    it('clones the repo into the workspace when credentials are set', async () => {
      process.env.ADO_ORG = 'https://dev.azure.com/amergis';
      process.env.ADO_PAT = 'secret-pat';
      mockFs.mkdirSync.mockImplementation(() => undefined);

      const workspaceDir = await checkoutDefaultBranch({
        project: 'MaxView',
        repo: 'MaxView',
        branch: 'main',
        sessionId: 'session-abc',
      });

      expect(workspaceDir).toBe(workspacePath('session-abc'));
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(workspacePath('session-abc'), {
        recursive: true,
      });
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git clone'),
        expect.objectContaining({ cwd: workspacePath('session-abc') }),
      );
    });
  });

  describe('createFeatureBranch', () => {
    it('creates a feature branch with workItemId and slugified title', () => {
      const branchName = createFeatureBranch('/tmp/workspace', 50743, 'Shift Scheduler Widget');

      expect(branchName).toBe('feature/apex-50743-shift-scheduler-widget');
      expect(mockExecSync).toHaveBeenCalledWith(
        'git checkout -b "feature/apex-50743-shift-scheduler-widget"',
        expect.objectContaining({ cwd: '/tmp/workspace' }),
      );
    });
  });
});
