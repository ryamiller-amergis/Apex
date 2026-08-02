jest.mock('../db/drizzle', () => ({ db: {} }));

const mockGit = jest.fn();
const mockReadCachedOriginSha = jest.fn();
jest.mock('../utils/asyncGit', () => ({
  git: (...args: unknown[]) => mockGit(...args),
  safeArgs: (dir: string, args: string[]) => [
    '-c',
    `safe.directory=${dir}`,
    ...args,
  ],
}));
jest.mock('../services/repoCacheService', () => ({
  getRepoCacheDir: () => 'C:\\opaque-cache.git',
  readCachedOriginSha: (...args: unknown[]) =>
    mockReadCachedOriginSha(...args),
}));

import type { RunGrounding } from '../../shared/types/runGrounding';
import { createGroundingStalenessService } from '../services/groundingStalenessService';

const NOW = Date.parse('2026-08-02T16:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const grounding = (ageMs: number): RunGrounding => ({
  id: 'grounding-1',
  runType: 'chat',
  runId: 'run-1',
  project: 'Apex',
  repoRole: 'target',
  provider: 'github',
  repository: 'AI-Pilot',
  branch: 'main',
  groundedSha: 'a'.repeat(40),
  groundedAt: new Date(NOW - ageMs).toISOString(),
  isActive: true,
  createdAt: new Date(NOW - ageMs).toISOString(),
  updatedAt: new Date(NOW - ageMs).toISOString(),
});

describe('TBI-007 groundingStalenessService', () => {
  it('DoD-3 returns fresh immediately before both soft boundaries', async () => {
    // Arrange
    const service = createGroundingStalenessService({
      now: () => NOW,
      countCommitsBehind: jest.fn().mockResolvedValue(49),
    });

    // Act
    const state = await service.evaluate(grounding(7 * DAY_MS - 1));

    // Assert
    expect(state).toBe('fresh');
  });

  it.each([
    ['exactly 7 days', 7 * DAY_MS, 0],
    ['exactly 50 commits', 0, 50],
  ])('DoD-3 returns soft-stale at %s', async (_label, ageMs, commits) => {
    // Arrange
    const source = grounding(ageMs);
    const originalSha = source.groundedSha;
    const service = createGroundingStalenessService({
      now: () => NOW,
      countCommitsBehind: jest.fn().mockResolvedValue(commits),
    });

    // Act
    const state = await service.evaluate(source);

    // Assert
    expect(state).toBe('soft-stale');
    expect(source.groundedSha).toBe(originalSha);
  });

  it('DoD-3/DoD-4 returns hard-checkpoint at exactly 14 days without mutating the pin', async () => {
    // Arrange
    const source = grounding(14 * DAY_MS);
    const snapshot = { ...source };
    const countCommitsBehind = jest.fn();
    const service = createGroundingStalenessService({
      now: () => NOW,
      countCommitsBehind,
    });

    // Act
    const state = await service.evaluate(source);

    // Assert
    expect(state).toBe('hard-checkpoint');
    expect(source).toEqual(snapshot);
    expect(countCommitsBehind).not.toHaveBeenCalled();
  });

  it('DoD-3 counts all-ancestry commits with groundedSha..originTip', async () => {
    // Arrange
    mockReadCachedOriginSha.mockResolvedValue('b'.repeat(40));
    mockGit.mockResolvedValue('50\n');
    const source = grounding(0);
    const service = createGroundingStalenessService({ now: () => NOW });

    // Act
    const state = await service.evaluate(source);

    // Assert
    expect(state).toBe('soft-stale');
    expect(mockGit).toHaveBeenCalledWith(
      expect.arrayContaining([
        'rev-list',
        '--count',
        `${source.groundedSha}..${'b'.repeat(40)}`,
      ]),
      { cwd: 'C:\\opaque-cache.git' },
    );
  });

  it('TBI-008 DoD-0 emits the redacted contract staleness event from evaluation', async () => {
    // Arrange
    const telemetry = jest.fn();
    const source = {
      ...grounding(7 * DAY_MS),
      repository:
        'https://user:repo-secret@example.invalid/org/repo?token=abc',
    };
    const service = createGroundingStalenessService({
      now: () => NOW,
      countCommitsBehind: jest.fn().mockResolvedValue(0),
      telemetry,
    });

    // Act
    await service.evaluate(source);

    // Assert
    expect(telemetry).toHaveBeenCalledWith(
      'grounding.staleness',
      expect.objectContaining({
        caller: 'grounding-staleness',
        project: 'Apex',
        runId: 'run-1',
      }),
      expect.objectContaining({
        breachCount: 1,
        ageMs: 7 * DAY_MS,
        commitCount: 0,
      }),
    );
    const serialized = JSON.stringify(telemetry.mock.calls);
    expect(serialized).not.toContain('repo-secret');
    expect(serialized).not.toContain('token=abc');
    expect(serialized).not.toContain('C:\\');
  });
});
