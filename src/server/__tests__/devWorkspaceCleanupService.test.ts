import path from 'path';
import {
  cleanupStaleDevWorkspaces,
  type DevWorkspaceCleanupFileSystem,
  type DevWorkspaceCleanupStore,
} from '../services/devWorkspaceCleanupService';

const NOW = Date.parse('2026-07-13T20:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function createFileSystem(
  directories: Record<string, number>,
): DevWorkspaceCleanupFileSystem & { rm: jest.Mock } {
  return {
    listDirectories: jest.fn().mockResolvedValue(Object.keys(directories)),
    modifiedAt: jest.fn().mockImplementation(async (directory: string) =>
      directories[path.basename(directory)],
    ),
    rm: jest.fn().mockResolvedValue(undefined),
  };
}

function createStore(
  sessions: Array<{ id: string; status: string; updatedAt: string }>,
): DevWorkspaceCleanupStore & { markStaleSetupFailed: jest.Mock } {
  return {
    listSessions: jest.fn().mockResolvedValue(sessions),
    markStaleSetupFailed: jest.fn().mockResolvedValue(true),
  };
}

describe('cleanupStaleDevWorkspaces', () => {
  it('removes terminal, stale-setup, and old orphan workspaces while retaining active work', async () => {
    const fileSystem = createFileSystem({
      failed: NOW - HOUR,
      closed: NOW - HOUR,
      staleSetup: NOW - 3 * HOUR,
      active: NOW - 7 * 24 * HOUR,
      conflict: NOW - 7 * 24 * HOUR,
      oldOrphan: NOW - 2 * 24 * HOUR,
    });
    const store = createStore([
      { id: 'failed', status: 'failed', updatedAt: '2026-07-13T19:00:00.000Z' },
      { id: 'closed', status: 'closed', updatedAt: '2026-07-13T19:00:00.000Z' },
      { id: 'staleSetup', status: 'setting_up', updatedAt: '2026-07-13T17:00:00.000Z' },
      { id: 'active', status: 'in_progress', updatedAt: '2026-07-06T20:00:00.000Z' },
      { id: 'conflict', status: 'conflict', updatedAt: '2026-07-06T20:00:00.000Z' },
    ]);

    const result = await cleanupStaleDevWorkspaces({
      workspaceRoot: '/data/dev-workspaces',
      nowMs: NOW,
      fileSystem,
      store,
    });

    const removedIds = fileSystem.rm.mock.calls.map(([directory]) => path.basename(directory));
    expect(removedIds).toEqual(expect.arrayContaining([
      'failed',
      'closed',
      'staleSetup',
      'oldOrphan',
    ]));
    expect(removedIds).not.toEqual(expect.arrayContaining(['active', 'conflict']));
    expect(store.markStaleSetupFailed).toHaveBeenCalledWith(
      'staleSetup',
      expect.any(String),
    );
    expect(result.removed).toBe(4);
  });

  it('retains recent setup and orphan workspaces', async () => {
    const fileSystem = createFileSystem({
      recentSetup: NOW - 10 * 60 * 1000,
      recentOrphan: NOW - HOUR,
    });
    const store = createStore([
      { id: 'recentSetup', status: 'setting_up', updatedAt: '2026-07-13T19:50:00.000Z' },
    ]);

    const result = await cleanupStaleDevWorkspaces({
      workspaceRoot: '/data/dev-workspaces',
      nowMs: NOW,
      fileSystem,
      store,
    });

    expect(fileSystem.rm).not.toHaveBeenCalled();
    expect(store.markStaleSetupFailed).not.toHaveBeenCalled();
    expect(result.removed).toBe(0);
  });

  it('does not delete a stale setup workspace when another process changed its status', async () => {
    const fileSystem = createFileSystem({ setup: NOW - 3 * HOUR });
    const store = createStore([
      { id: 'setup', status: 'setting_up', updatedAt: '2026-07-13T17:00:00.000Z' },
    ]);
    store.markStaleSetupFailed.mockResolvedValue(false);

    await cleanupStaleDevWorkspaces({
      workspaceRoot: '/data/dev-workspaces',
      nowMs: NOW,
      fileSystem,
      store,
    });

    expect(fileSystem.rm).not.toHaveBeenCalled();
  });
});
