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
});
