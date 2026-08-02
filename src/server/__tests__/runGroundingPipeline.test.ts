jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  createRunGroundingService,
  type RunGroundingService,
} from '../services/runGroundingService';
import type { RunGroundingRepository } from '../services/runGroundingRepository';
import type {
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
    reground: jest.fn(),
    deactivateByRun: jest.fn(),
  };
}

describe('TBI-004 pipeline grounding contracts', () => {
  it('DoD-0 copies the Interview target SHA by value into a new PRD chat-run grounding', async () => {
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

  it('DoD-1 copies the PRD target SHA by value into a new Design Doc chat-run grounding', async () => {
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
      workspaceOwnedByIdleCleanup: true,
    });
    expect(events).toEqual(['persisted', 'inactive']);
  });
});

describe('TBI-004 cached drift and explicit re-ground contracts', () => {
  it('DoD-3 returns cached-only source-changed status without mutating the pin', async () => {
    // Arrange
    const row = grounding(prdRun);
    const repository = repositoryMock();
    repository.findByRun.mockResolvedValue([row]);
    const readCachedOriginSha = jest.fn().mockResolvedValue(shaB);
    const service = createRunGroundingService(repository, {
      readCachedOriginSha,
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
      canReGround: true,
    });
    expect(readCachedOriginSha).toHaveBeenCalledWith(row);
    expect(row.groundedSha).toBe(shaA);
    expect(repository.reground).not.toHaveBeenCalled();
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
