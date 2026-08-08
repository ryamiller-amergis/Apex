import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

jest.mock('../db/drizzle', () => ({ db: {} }));

import type { RunGrounding } from '../../shared/types/runGrounding';
import { createGroundingEvictionService } from '../services/groundingEvictionService';
import { resolveRunGroundingWorkspacePath } from '../services/runGroundingMaterializer';

const NOW = Date.parse('2026-08-02T16:00:00.000Z');
const activeGrounding: RunGrounding = {
  id: 'grounding-active',
  runType: 'chat',
  runId: 'run-active',
  project: 'Apex',
  repoRole: 'target',
  provider: 'github',
  repository: 'AI-Pilot',
  branch: 'main',
  groundedSha: 'a'.repeat(40),
  groundedAt: '2026-08-02T15:00:00.000Z',
  isActive: true,
  createdAt: '2026-08-02T15:00:00.000Z',
  updatedAt: '2026-08-02T15:00:00.000Z',
};

describe('TBI-007 groundingEvictionService', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grounding-eviction-'));
  });

  afterEach(async () => {
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it('DoD-2 removes only inactive worktrees idle beyond 30 minutes and protects active paths and bundles', async () => {
    // Arrange
    const workspaces = path.join(dataRoot, 'grounding-workspaces');
    const activePath = resolveRunGroundingWorkspacePath(
      activeGrounding,
      activeGrounding,
      dataRoot,
    );
    const inactiveIdlePath = path.join(workspaces, 'inactive-idle');
    const inactiveRecentPath = path.join(workspaces, 'inactive-recent');
    const durableBundle = path.join(
      dataRoot,
      'repo-grounding',
      'durable.bundle',
    );
    await Promise.all([
      fs.mkdir(activePath, { recursive: true }),
      fs.mkdir(inactiveIdlePath, { recursive: true }),
      fs.mkdir(inactiveRecentPath, { recursive: true }),
      fs.mkdir(path.dirname(durableBundle), { recursive: true }),
    ]);
    await fs.writeFile(durableBundle, 'durable');
    const idleTime = new Date(NOW - 30 * 60 * 1000 - 1);
    const recentTime = new Date(NOW - 30 * 60 * 1000 + 1);
    await fs.utimes(activePath, idleTime, idleTime);
    await fs.utimes(inactiveIdlePath, idleTime, idleTime);
    await fs.utimes(inactiveRecentPath, recentTime, recentTime);
    const service = createGroundingEvictionService({
      dataRoot,
      now: () => NOW,
      listActiveGroundings: jest.fn().mockResolvedValue([activeGrounding]),
    });

    // Act
    const result = await service.evictIdle();

    // Assert
    expect(result).toEqual({ scanned: 3, evicted: 1, protected: 1 });
    await expect(fs.stat(activePath)).resolves.toBeDefined();
    await expect(fs.stat(inactiveIdlePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fs.stat(inactiveRecentPath)).resolves.toBeDefined();
    await expect(fs.readFile(durableBundle, 'utf8')).resolves.toBe('durable');
  });

  it('TBI-006 DoD-3 / PBI-005 BR-008 / VT-07 retains non-terminal and terminal-but-unconsumed active groundings and removes consumed inactive stale workspace', async () => {
    // Arrange: active grounding is the durable protection signal for both
    // non-terminal and terminal runs whose artifacts are not yet consumed.
    const nonTerminalGrounding: RunGrounding = {
      ...activeGrounding,
      id: 'grounding-non-terminal',
      runId: 'run-non-terminal',
    };
    const terminalUnconsumedGrounding: RunGrounding = {
      ...activeGrounding,
      id: 'grounding-terminal-unconsumed',
      runId: 'run-terminal-unconsumed',
    };
    const consumedGrounding: RunGrounding = {
      ...activeGrounding,
      id: 'grounding-consumed',
      runId: 'run-consumed',
      isActive: false,
    };
    const nonTerminalPath = resolveRunGroundingWorkspacePath(
      nonTerminalGrounding,
      nonTerminalGrounding,
      dataRoot,
    );
    const terminalUnconsumedPath = resolveRunGroundingWorkspacePath(
      terminalUnconsumedGrounding,
      terminalUnconsumedGrounding,
      dataRoot,
    );
    const consumedPath = resolveRunGroundingWorkspacePath(
      consumedGrounding,
      consumedGrounding,
      dataRoot,
    );
    await Promise.all([
      fs.mkdir(nonTerminalPath, { recursive: true }),
      fs.mkdir(terminalUnconsumedPath, { recursive: true }),
      fs.mkdir(consumedPath, { recursive: true }),
    ]);
    const staleTime = new Date(NOW - 30 * 60 * 1000 - 1);
    await Promise.all([
      fs.utimes(nonTerminalPath, staleTime, staleTime),
      fs.utimes(terminalUnconsumedPath, staleTime, staleTime),
      fs.utimes(consumedPath, staleTime, staleTime),
    ]);
    const listActiveGroundings = jest.fn().mockResolvedValue([
      nonTerminalGrounding,
      terminalUnconsumedGrounding,
    ]);
    const service = createGroundingEvictionService({
      dataRoot,
      now: () => NOW,
      listActiveGroundings,
    });

    // Act
    const result = await service.evictIdle();

    // Assert: persistThenMarkTerminalInactive makes the consumed workspace
    // eligible by removing it from the active-grounding set.
    expect(listActiveGroundings).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ scanned: 3, evicted: 1, protected: 2 });
    await expect(fs.stat(nonTerminalPath)).resolves.toBeDefined();
    await expect(fs.stat(terminalUnconsumedPath)).resolves.toBeDefined();
    await expect(fs.stat(consumedPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
