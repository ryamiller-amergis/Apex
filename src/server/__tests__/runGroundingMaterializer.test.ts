jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  createRunGroundingMaterializer,
  type GroundingMaterializerDependencies,
} from '../services/runGroundingMaterializer';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';

const sha = 'a'.repeat(40);
const groundedAt = '2026-08-02T14:00:00.000Z';
const grounding: RunGrounding = {
  id: 'grounding-1',
  runType: 'chat',
  runId: 'source-thread',
  project: 'Apex',
  repoRole: 'target',
  provider: 'github',
  repository: 'AI-Pilot',
  branch: 'main',
  groundedSha: sha,
  groundedAt,
  isActive: true,
  createdAt: groundedAt,
  updatedAt: groundedAt,
};

function run(runId: string): RunRef {
  return { runType: 'chat', runId, project: 'Apex' };
}

describe('TBI-004 default independent grounding materializer', () => {
  it('DoD-0/DoD-1 uses distinct opaque destinations and passes the exact copied SHA', async () => {
    // Arrange
    const rehydrate = jest.fn().mockResolvedValue({
      status: 'materialized',
      source: 'bundle',
    });
    const createBundleStore = jest.fn(() => ({ rehydrate }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
    });

    // Act
    const first = await materialize(grounding, run('prd-thread'));
    const second = await materialize(grounding, run('design-doc-thread'));

    // Assert
    expect(first).toBe('materialized');
    expect(second).toBe('materialized');
    expect(rehydrate).toHaveBeenCalledTimes(2);
    const [firstIdentity, firstDestination] = rehydrate.mock.calls[0];
    const [secondIdentity, secondDestination] = rehydrate.mock.calls[1];
    expect(firstIdentity).toEqual({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      sha,
    });
    expect(secondIdentity.sha).toBe(sha);
    expect(firstDestination).not.toBe(secondDestination);
    expect(firstDestination).toMatch(
      new RegExp(`grounding-workspaces[\\\\/]\\w+$`),
    );
    expect(firstDestination).not.toContain('prd-thread');
    expect(secondDestination).not.toContain('design-doc-thread');
  });

  it('DoD-0/DoD-1 returns controlled unavailable when bundle materialization falls back', async () => {
    // Arrange
    const createBundleStore = jest.fn(() => ({
      rehydrate: jest.fn().mockResolvedValue({
        status: 'remote-fallback',
        reason: 'repair-failed',
      }),
    }));
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
    });

    // Act
    const result = await materialize(grounding, run('prd-thread'));

    // Assert
    expect(result).toBe('unavailable');
    expect(grounding.groundedSha).toBe(sha);
  });

  it('DoD-0/DoD-1 repair clones cache then detach-checks out the copied SHA', async () => {
    // Arrange
    const createBundleStore: GroundingMaterializerDependencies['createBundleStore'] =
      jest.fn((options) => {
        return {
          rehydrate: jest.fn(async (identity, destination) => {
            const repaired = await options.repairAndMaterialize({
              identity,
              destination,
            });
            return repaired
              ? { status: 'materialized' as const, source: 'repair' as const }
              : {
                  status: 'remote-fallback' as const,
                  reason: 'repair-failed' as const,
                };
          }),
        };
      });
    const ensureRepoCache = jest.fn().mockResolvedValue({
      cacheDir: 'C:\\cache\\repo.git',
      remote: { url: 'https://example.invalid/repo.git' },
    });
    const materializeWorkspaceFromCache = jest.fn().mockResolvedValue(undefined);
    const runGit = jest.fn().mockResolvedValue('');
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore,
      ensureRepoCache,
      materializeWorkspaceFromCache,
      runGit,
    });

    // Act
    const repaired = await materialize(grounding, run('prd-thread'));

    // Assert
    expect(repaired).toBe('materialized');
    expect(ensureRepoCache).toHaveBeenCalledWith({
      provider: 'github',
      project: 'Apex',
      repo: 'AI-Pilot',
      branch: 'main',
    });
    expect(materializeWorkspaceFromCache).toHaveBeenCalledWith(
      'C:\\cache\\repo.git',
      expect.stringMatching(/grounding-workspaces/),
      'main',
      'https://example.invalid/repo.git',
    );
    const destination = materializeWorkspaceFromCache.mock.calls[0][1];
    expect(runGit).toHaveBeenCalledWith(
      expect.arrayContaining(['checkout', '--detach', sha]),
      { cwd: destination },
    );
  });
});
