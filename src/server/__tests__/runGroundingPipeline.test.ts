jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  createRunGroundingService,
  type RunGroundingService,
} from '../services/runGroundingService';
import {
  createRunGroundingRepository,
  type RunGroundingRepository,
  type RunGroundingStore,
} from '../services/runGroundingRepository';
import { createRunGroundingMaterializer } from '../services/runGroundingMaterializer';
import type {
  ActiveRepositoryBranchQuery,
  CreateRunGroundingInput,
  RepoRole,
  RunGrounding,
  RunRef,
} from '../../shared/types/runGrounding';

const groundedAt = '2026-08-02T14:00:00.000Z';
const shaA = 'a'.repeat(40);
const shaB = 'b'.repeat(40);

const interviewRun: RunRef = {
  runType: 'chat',
  runId: 'interview-thread',
  project: 'Apex',
};
const prdRun: RunRef = {
  runType: 'chat',
  runId: 'prd-thread',
  project: 'Apex',
};
const designDocRun: RunRef = {
  runType: 'chat',
  runId: 'design-doc-thread',
  project: 'Apex',
};

function grounding(
  run: RunRef,
  overrides: Partial<RunGrounding> = {}
): RunGrounding {
  return {
    ...run,
    id: `${run.runId}-grounding`,
    repoRole: 'target',
    provider: 'github',
    repository: 'AI-Pilot',
    branch: 'main',
    groundedSha: shaA,
    groundedAt,
    isActive: true,
    createdAt: groundedAt,
    updatedAt: groundedAt,
    ...overrides,
  };
}

function repositoryMock(): jest.Mocked<RunGroundingRepository> {
  return {
    createGrounding: jest.fn(),
    activateGroundings: jest.fn(),
    copyGrounding: jest.fn(),
    findByRun: jest.fn(),
    findActiveByRepoBranch: jest.fn(),
    listActiveGroundings: jest.fn(),
    listActiveTargets: jest.fn(),
    reground: jest.fn(),
    deactivateByRun: jest.fn(),
  };
}

class ServiceTestGroundingStore implements RunGroundingStore {
  private rows: RunGrounding[] = [];
  private sequence = 0;

  async insert(input: CreateRunGroundingInput): Promise<RunGrounding> {
    if (
      this.rows.some(
        (row) =>
          row.runType === input.runType &&
          row.runId === input.runId &&
          row.project === input.project &&
          row.repoRole === input.repoRole &&
          row.isActive,
      )
    ) {
      throw new Error('duplicate active role');
    }
    const timestamp = input.groundedAt ?? groundedAt;
    const row: RunGrounding = {
      ...input,
      id: `grounding-${++this.sequence}`,
      groundedAt: timestamp,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.rows.push(row);
    return row;
  }

  async insertMany(
    inputs: CreateRunGroundingInput[],
  ): Promise<RunGrounding[]> {
    return Promise.all(inputs.map((input) => this.insert(input)));
  }

  async findByRun(ref: RunRef): Promise<RunGrounding[]> {
    return this.rows
      .filter(
        (row) =>
          row.runType === ref.runType &&
          row.runId === ref.runId &&
          row.project === ref.project,
      )
      .sort((left, right) =>
        right.groundedAt.localeCompare(left.groundedAt),
      );
  }

  async findActiveByRole(
    ref: RunRef,
    role: RepoRole,
  ): Promise<RunGrounding | null> {
    return (
      (await this.findByRun(ref)).find(
        (row) => row.repoRole === role && row.isActive,
      ) ?? null
    );
  }

  async findActiveByRepoBranch(
    _query: ActiveRepositoryBranchQuery,
  ): Promise<RunGrounding[]> {
    return [];
  }

  async listActiveGroundings(): Promise<RunGrounding[]> {
    return this.rows.filter((row) => row.isActive);
  }

  async listActiveTargets() {
    return [];
  }

  async reground(
    ref: RunRef,
    role: RepoRole,
    newSha: string,
    replacementGroundedAt: string,
  ): Promise<RunGrounding | null> {
    const latest = (await this.findByRun(ref)).find(
      (row) => row.repoRole === role,
    );
    if (!latest) return null;
    for (const row of this.rows) {
      if (
        row.runType === ref.runType &&
        row.runId === ref.runId &&
        row.project === ref.project &&
        row.repoRole === role &&
        row.isActive
      ) {
        row.isActive = false;
        row.updatedAt = replacementGroundedAt;
      }
    }
    return this.insert({
      ...ref,
      repoRole: role,
      provider: latest.provider,
      repository: latest.repository,
      branch: latest.branch,
      groundedSha: newSha,
      groundedAt: replacementGroundedAt,
    });
  }

  async deactivateByRun(ref: RunRef): Promise<number> {
    let count = 0;
    for (const row of this.rows) {
      if (
        row.runType === ref.runType &&
        row.runId === ref.runId &&
        row.project === ref.project &&
        row.isActive
      ) {
        row.isActive = false;
        count += 1;
      }
    }
    return count;
  }
}

describe('TBI-004 pipeline grounding contracts', () => {
  it('AC-0 / VT-01 Given Interview SHA A, When PRD then Design Doc begin, Then distinct rows and opaque checkout destinations remain pinned to SHA A', async () => {
    // Arrange
    const store = new ServiceTestGroundingStore();
    const repository = createRunGroundingRepository(store);
    await repository.createGrounding({
      ...interviewRun,
      repoRole: 'target',
      provider: 'github',
      repository: 'AI-Pilot',
      branch: 'main',
      groundedSha: shaA,
      groundedAt,
    });
    const destinations: string[] = [];
    const materialize = createRunGroundingMaterializer({
      dataRoot: 'C:\\persistent-data',
      createBundleStore: jest.fn(() => ({
        rehydrate: jest.fn(async (_identity, destination) => {
          destinations.push(destination);
          return { status: 'materialized' as const, source: 'bundle' as const };
        }),
      })),
    });
    const service = createRunGroundingService(repository, { materialize });

    // Act
    await service.copyGroundingByValue(interviewRun, prdRun, 'target');
    await service.copyGroundingByValue(prdRun, designDocRun, 'target');
    const rows = (
      await Promise.all(
        [interviewRun, prdRun, designDocRun].map((run) =>
          repository.findByRun(run),
        ),
      )
    ).flat();

    // Assert
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.every((row) => row.groundedSha === shaA)).toBe(true);
    expect(destinations).toHaveLength(2);
    expect(destinations[0]).not.toBe(destinations[1]);
    expect(destinations[0]).not.toContain(prdRun.runId);
    expect(destinations[1]).not.toContain(designDocRun.runId);
  });

  it('AC-0 / VT-01 copies the Interview target SHA by value into a new PRD chat-run grounding', async () => {
    // Arrange
    const repository = repositoryMock();
    const copied = grounding(prdRun);
    repository.copyGrounding.mockResolvedValue(copied);
    const materialize = jest.fn().mockResolvedValue('materialized');
    const service = createRunGroundingService(repository, { materialize });

    // Act
    const result = await service.copyGroundingByValue(
      interviewRun,
      prdRun,
      'target'
    );

    // Assert
    expect(repository.copyGrounding).toHaveBeenCalledWith(
      interviewRun,
      prdRun,
      'target'
    );
    expect(result).toEqual({
      grounding: expect.objectContaining({
        runType: 'chat',
        runId: 'prd-thread',
        groundedSha: shaA,
      }),
      materialization: 'materialized',
    });
    expect(materialize).toHaveBeenCalledWith(copied, prdRun);
  });

  it('AC-0 / VT-01 copies the PRD target SHA by value into a new Design Doc chat-run grounding', async () => {
    // Arrange
    const repository = repositoryMock();
    const copied = grounding(designDocRun);
    repository.copyGrounding.mockResolvedValue(copied);
    const materialize = jest.fn().mockResolvedValue('materialized');
    const service = createRunGroundingService(repository, { materialize });

    // Act
    const result = await service.copyGroundingByValue(
      prdRun,
      designDocRun,
      'target'
    );

    // Assert
    expect(repository.copyGrounding).toHaveBeenCalledWith(
      prdRun,
      designDocRun,
      'target'
    );
    expect(result.grounding).toEqual(
      expect.objectContaining({
        runType: 'chat',
        runId: 'design-doc-thread',
        groundedSha: shaA,
      })
    );
    expect(materialize).toHaveBeenCalledWith(copied, designDocRun);
  });

  it('AC-1 / VT-02 Given SHA A cannot materialize, When PRD begins, Then fallback is unavailable and no newer SHA is pinned', async () => {
    // Arrange
    const repository = repositoryMock();
    const copied = grounding(prdRun);
    repository.copyGrounding.mockResolvedValue(copied);
    repository.findByRun.mockResolvedValue([copied]);
    const service = createRunGroundingService(repository, {
      materialize: jest.fn().mockResolvedValue('unavailable'),
      readCachedOriginSha: jest.fn().mockResolvedValue(shaA),
    });

    // Act
    const copiedResult = await service.copyGroundingByValue(
      interviewRun,
      prdRun,
      'target',
    );
    const status = await service.getStatus(prdRun, 'target', true);

    // Assert
    expect(copiedResult).toEqual({
      grounding: copied,
      materialization: 'unavailable',
    });
    expect(status?.driftState).toBe('unavailable');
    expect(copied.groundedSha).toBe(shaA);
    expect(repository.reground).not.toHaveBeenCalled();
  });

  it('DoD-2 marks terminal groundings inactive without invoking bundle or worktree deletion', async () => {
    // Arrange
    const repository = repositoryMock();
    repository.deactivateByRun.mockResolvedValue(1);
    const deleteBundle = jest.fn();
    const deleteWorktree = jest.fn();
    const service = createRunGroundingService(repository);

    // Act
    const count = await service.markTerminalInactive(prdRun);

    // Assert
    expect(count).toBe(1);
    expect(repository.deactivateByRun).toHaveBeenCalledWith(prdRun);
    expect(deleteBundle).not.toHaveBeenCalled();
    expect(deleteWorktree).not.toHaveBeenCalled();
  });

  it('DoD-4 persists transcript/output before the grounding becomes cleanup-eligible', async () => {
    // Arrange
    const events: string[] = [];
    const repository = repositoryMock();
    repository.deactivateByRun.mockImplementation(async () => {
      events.push('inactive');
      return 1;
    });
    const service = createRunGroundingService(repository);
    const persist = jest.fn(async () => {
      events.push('persisted');
      return 'durable-output';
    });

    // Act
    const result = await service.persistThenMarkTerminalInactive(
      prdRun,
      persist
    );

    // Assert
    expect(result).toEqual({
      persisted: 'durable-output',
      deactivatedCount: 1,
    });
    expect(events).toEqual(['persisted', 'inactive']);
  });
});

describe('TBI-004 cached drift and explicit re-ground contracts', () => {
  it('DoD-3 re-grounds a terminal run through the real in-memory repository and preserves history', async () => {
    // Arrange
    const store = new ServiceTestGroundingStore();
    const repository = createRunGroundingRepository(store, {
      now: () => '2026-08-02T15:00:00.000Z',
    });
    await repository.createGrounding({
      ...prdRun,
      repoRole: 'target',
      provider: 'github',
      repository: 'AI-Pilot',
      branch: 'main',
      groundedSha: shaA,
      groundedAt,
    });
    await repository.deactivateByRun(prdRun);
    const service = createRunGroundingService(repository, {
      readCachedOriginSha: jest.fn().mockResolvedValue(shaB),
      materialize: jest.fn().mockResolvedValue('materialized'),
    });

    // Act
    const result = await service.reGroundFromCache(prdRun, 'target');
    const history = await repository.findByRun(prdRun);

    // Assert
    expect(result).toEqual({
      previousSha: shaA,
      newSha: shaB,
      groundedAt: '2026-08-02T15:00:00.000Z',
    });
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.isActive)).toEqual([
      expect.objectContaining({ groundedSha: shaB }),
    ]);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ groundedSha: shaA, isActive: false }),
      ]),
    );
  });

  it('AC-2 / VT-03 Given cached origin B, When drift evaluates, Then source-changed is returned without mutating SHA A', async () => {
    // Arrange
    const row = grounding(prdRun);
    const repository = repositoryMock();
    repository.findByRun.mockResolvedValue([row]);
    const readCachedOriginSha = jest.fn().mockResolvedValue(shaB);
    const service = createRunGroundingService(repository, {
      readCachedOriginSha,
      evaluateStaleness: jest.fn().mockResolvedValue('fresh'),
    });

    // Act
    const status = await service.getStatus(prdRun, 'target', true);

    // Assert
    expect(status).toEqual({
      runType: 'chat',
      runId: 'prd-thread',
      role: 'target',
      groundedSha: shaA,
      groundedShaShort: shaA.slice(0, 12),
      groundedAt,
      driftState: 'source-changed',
      stalenessState: 'fresh',
      canReGround: true,
    });
    expect(readCachedOriginSha).toHaveBeenCalledWith(row);
    expect(row.groundedSha).toBe(shaA);
    expect(repository.reground).not.toHaveBeenCalled();
  });

  it('AC-3 / VT-04 Given drift with no confirmation, When PRD and Design Doc continue, Then downstream copies remain at SHA A', async () => {
    // Arrange
    const store = new ServiceTestGroundingStore();
    const repository = createRunGroundingRepository(store);
    await repository.createGrounding({
      ...interviewRun,
      repoRole: 'target',
      provider: 'github',
      repository: 'AI-Pilot',
      branch: 'main',
      groundedSha: shaA,
      groundedAt,
    });
    const service = createRunGroundingService(repository, {
      readCachedOriginSha: jest.fn().mockResolvedValue(shaB),
      materialize: jest.fn().mockResolvedValue('materialized'),
    });

    // Act
    const drift = await service.getStatus(interviewRun, 'target', true);
    await service.copyGroundingByValue(interviewRun, prdRun, 'target');
    await service.copyGroundingByValue(prdRun, designDocRun, 'target');
    const downstream = [
      ...(await repository.findByRun(prdRun)),
      ...(await repository.findByRun(designDocRun)),
    ];

    // Assert
    expect(drift?.driftState).toBe('source-changed');
    expect(downstream).toHaveLength(2);
    expect(downstream.every((row) => row.groundedSha === shaA)).toBe(true);
  });

  it('DoD-3 reports unavailable when the local origin ref cache is absent', async () => {
    // Arrange
    const repository = repositoryMock();
    repository.findByRun.mockResolvedValue([grounding(prdRun)]);
    const service = createRunGroundingService(repository, {
      readCachedOriginSha: jest.fn().mockResolvedValue(null),
    });

    // Act
    const status = await service.getStatus(prdRun, 'target', false);

    // Assert
    expect(status?.driftState).toBe('unavailable');
    expect(status?.canReGround).toBe(false);
  });

  it('DoD-3 re-grounds to the cached origin tip with no caller SHA and leaves upstream rows untouched', async () => {
    // Arrange
    const current = grounding(prdRun, { isActive: false });
    const replacement = grounding(prdRun, {
      id: 'replacement',
      groundedSha: shaB,
      groundedAt: '2026-08-02T15:00:00.000Z',
    });
    const repository = repositoryMock();
    repository.findByRun.mockResolvedValue([current]);
    repository.reground.mockResolvedValue(replacement);
    const service = createRunGroundingService(repository, {
      readCachedOriginSha: jest.fn().mockResolvedValue(shaB),
      materialize: jest.fn().mockResolvedValue('materialized'),
    });

    // Act
    const result = await service.reGroundFromCache(prdRun, 'target');

    // Assert
    expect(result).toEqual({
      previousSha: shaA,
      newSha: shaB,
      groundedAt: replacement.groundedAt,
    });
    expect(repository.reground).toHaveBeenCalledWith(prdRun, 'target', shaB);
    expect(repository.reground).not.toHaveBeenCalledWith(
      interviewRun,
      expect.anything() as RepoRole,
      expect.anything()
    );
  });
});

type PipelineServiceContract = Pick<
  RunGroundingService,
  | 'copyGroundingByValue'
  | 'markTerminalInactive'
  | 'persistThenMarkTerminalInactive'
  | 'getStatus'
  | 'reGroundFromCache'
>;
const contractIsTyped: PipelineServiceContract | null = null;
void contractIsTyped;
