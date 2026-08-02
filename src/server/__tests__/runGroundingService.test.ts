jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  createRunGroundingService,
  type RepositoryGroundingPin,
  type RunGroundingService,
} from '../services/runGroundingService';
import {
  RunGroundingRepositoryError,
  type RunGroundingRepository,
} from '../services/runGroundingRepository';
import type {
  CreateRunGroundingInput,
  RepoRole,
  RunGrounding,
  RunRef,
} from '../../shared/types/runGrounding';

const run: RunRef = {
  runType: 'chat',
  runId: 'run-1',
  project: 'Apex',
};

const groundedAt = '2026-08-02T14:00:00.000Z';

const targetPin: RepositoryGroundingPin = {
  provider: 'github',
  repository: 'ASM/AI-Pilot',
  branch: 'main',
  groundedSha: 'target-sha',
};

const skillPin: RepositoryGroundingPin = {
  provider: 'github',
  repository: 'ASM/agent-skills',
  branch: 'main',
  groundedSha: 'skill-sha',
};

function grounding(
  repoRole: RepoRole,
  overrides: Partial<RunGrounding> = {}
): RunGrounding {
  return {
    ...run,
    id: `${repoRole}-grounding-id`,
    repoRole,
    provider: 'github',
    repository:
      repoRole === 'target' ? targetPin.repository : skillPin.repository,
    branch: 'main',
    groundedSha:
      repoRole === 'target' ? targetPin.groundedSha : skillPin.groundedSha,
    groundedAt,
    isActive: true,
    createdAt: groundedAt,
    updatedAt: groundedAt,
    ...overrides,
  };
}

function repositoryMock(
  overrides: Partial<jest.Mocked<RunGroundingRepository>> = {}
): jest.Mocked<RunGroundingRepository> {
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
    ...overrides,
  };
}

describe('runGroundingService AC-0 activation', () => {
  it('AC-0 Given target and optional skill pins, When activation begins, Then it creates one exact active row per role at the same grounded time', async () => {
    // Arrange
    const repository = repositoryMock();
    repository.activateGroundings.mockResolvedValue([
      grounding('target'),
      grounding('skill'),
    ]);
    const service = createRunGroundingService(repository, {
      now: () => groundedAt,
    });

    // Act
    const result = await service.activateGroundings({
      run,
      target: targetPin,
      skill: skillPin,
    });

    // Assert
    expect(result).toEqual({
      ok: true,
      durableGrounding: true,
      fallback: 'none',
      groundings: [grounding('target'), grounding('skill')],
    });
    expect(repository.activateGroundings).toHaveBeenCalledTimes(1);
    expect(repository.activateGroundings).toHaveBeenCalledWith([
      {
        ...run,
        repoRole: 'target',
        ...targetPin,
        groundedAt,
      },
      {
        ...run,
        repoRole: 'skill',
        ...skillPin,
        groundedAt,
      },
    ]);
  });
});

describe('runGroundingService AC-1 controlled fallback', () => {
  it('AC-1 Given a startup write failure, When activation is attempted, Then it returns typed remote fallback without throwing or claiming durable grounding', async () => {
    // Arrange
    const repository = repositoryMock();
    repository.activateGroundings.mockRejectedValue(
      new RunGroundingRepositoryError('activate')
    );
    repository.findByRun.mockResolvedValue([]);
    const service = createRunGroundingService(repository, {
      now: () => groundedAt,
    });

    // Act
    const activation = service.activateGroundings({
      run,
      target: targetPin,
      skill: skillPin,
    });

    // Assert
    await expect(activation).resolves.toEqual({
      ok: false,
      durableGrounding: false,
      fallback: 'remote',
      code: 'run_grounding_activation_failed',
    });
    await expect(service.getGroundings(run)).resolves.toEqual([]);
    expect(repository.activateGroundings).toHaveBeenCalledTimes(1);
    expect(repository.createGrounding).not.toHaveBeenCalled();
    expect(repository.deactivateByRun).not.toHaveBeenCalled();
  });

  it('AC-1 Given an unexpected programmer error, When activation is attempted, Then the error propagates instead of being mislabeled as persistence fallback', async () => {
    // Arrange
    const repository = repositoryMock();
    repository.activateGroundings.mockRejectedValue(
      new TypeError('invalid repository implementation')
    );
    const service = createRunGroundingService(repository);

    // Act
    const activation = service.activateGroundings({
      run,
      target: targetPin,
    });

    // Assert
    await expect(activation).rejects.toThrow(
      'invalid repository implementation'
    );
  });

  it('AC-1 Given an unrelated query failure, When grounding is read, Then the read error is not converted into startup fallback', async () => {
    // Arrange
    const repository = repositoryMock();
    repository.findByRun.mockRejectedValue(new Error('query failed'));
    const service = createRunGroundingService(repository);

    // Act
    const query = service.getGroundings(run);

    // Assert
    await expect(query).rejects.toThrow('query failed');
  });
});

describe('runGroundingService AC-2 independent roles', () => {
  it('AC-2 Given target and skill rows, When scoped grounding is queried, Then both independent pins are returned without collision', async () => {
    // Arrange
    const rows = [grounding('target'), grounding('skill')];
    const repository = repositoryMock();
    repository.findByRun.mockResolvedValue(rows);
    const service = createRunGroundingService(repository);

    // Act
    const result = await service.getGroundings(run);

    // Assert
    expect(result).toEqual(rows);
    expect(result.map((row) => [row.repoRole, row.groundedSha])).toEqual([
      ['target', 'target-sha'],
      ['skill', 'skill-sha'],
    ]);
    expect(repository.findByRun).toHaveBeenCalledWith(run);
  });
});

describe('runGroundingService AC-3 scope isolation', () => {
  it('AC-3 Given an unrelated run or project, When read/copy/re-ground/deactivate are attempted, Then no row is exposed or changed', async () => {
    // Arrange
    const unrelated: RunRef = { ...run, project: 'Other Project' };
    const destination: RunRef = {
      runType: 'service',
      runId: 'run-2',
      project: 'Apex',
    };
    const repository = repositoryMock();
    repository.findByRun.mockResolvedValue([]);
    repository.copyGrounding.mockResolvedValue(null);
    repository.reground.mockResolvedValue(null);
    repository.deactivateByRun.mockResolvedValue(0);
    const service = createRunGroundingService(repository);

    // Act
    const [rows, copied, regrounded, deactivated] = await Promise.all([
      service.getGroundings(unrelated),
      service.copyGrounding(unrelated, destination, 'target'),
      service.reground(unrelated, 'target', 'hidden-sha'),
      service.deactivate(unrelated),
    ]);

    // Assert
    expect({ rows, copied, regrounded, deactivated }).toEqual({
      rows: [],
      copied: null,
      regrounded: null,
      deactivated: 0,
    });
    expect(repository.findByRun).toHaveBeenCalledWith(unrelated);
    expect(repository.copyGrounding).toHaveBeenCalledWith(
      unrelated,
      destination,
      'target'
    );
    expect(repository.reground).toHaveBeenCalledWith(
      unrelated,
      'target',
      'hidden-sha'
    );
    expect(repository.deactivateByRun).toHaveBeenCalledWith(unrelated);
  });
});

describe('runGroundingService BR-005 lifecycle history', () => {
  it('BR-005 Given active target and skill roles, When re-grounding then terminal deactivation occurs, Then history remains and every run role becomes inactive without deletion', async () => {
    // Arrange
    const oldTarget = grounding('target', { id: 'old-target' });
    const newTarget = grounding('target', {
      id: 'new-target',
      groundedSha: 'new-target-sha',
    });
    const skill = grounding('skill');
    const history = [
      { ...oldTarget, isActive: false },
      { ...newTarget, isActive: false },
      { ...skill, isActive: false },
    ];
    const repository = repositoryMock();
    repository.reground.mockResolvedValue(newTarget);
    repository.deactivateByRun.mockResolvedValue(2);
    repository.findByRun.mockResolvedValue(history);
    const service = createRunGroundingService(repository);

    // Act
    const replacement = await service.reground(run, 'target', 'new-target-sha');
    const deactivated = await service.deactivate(run);
    const retainedHistory = await service.getGroundings(run);

    // Assert
    expect(replacement).toEqual(newTarget);
    expect(deactivated).toBe(2);
    expect(retainedHistory).toHaveLength(3);
    expect(retainedHistory.every((row) => !row.isActive)).toBe(true);
    expect(retainedHistory.map((row) => row.id)).toEqual([
      'old-target',
      'new-target',
      'skill-grounding-id',
    ]);
  });
});

describe('runGroundingService security contract', () => {
  it('security Given lifecycle input, When activation and mutations execute, Then only credential-free pins and scoped RunRef values reach persistence', async () => {
    // Arrange
    type ForbiddenPinFieldsAbsent =
      Extract<
        keyof RepositoryGroundingPin,
        'credentials' | 'token' | 'checkoutPath' | 'localPath'
      > extends never
        ? true
        : false;
    type DeactivateScope = Parameters<RunGroundingService['deactivate']>[0];
    const forbiddenPinFieldsAbsent: ForbiddenPinFieldsAbsent = true;
    const scopedMutation: DeactivateScope = run;
    const repository = repositoryMock();
    repository.activateGroundings.mockResolvedValue([grounding('target')]);
    repository.deactivateByRun.mockResolvedValue(1);
    const service = createRunGroundingService(repository, {
      now: () => groundedAt,
    });
    const taintedInput = {
      run,
      target: {
        ...targetPin,
        credentials: 'secret',
        checkoutPath: 'C:\\secret\\checkout',
      },
    };

    // Act
    await service.activateGroundings(taintedInput);
    await service.deactivate(scopedMutation);

    // Assert
    expect(forbiddenPinFieldsAbsent).toBe(true);
    const [persisted] = repository.activateGroundings.mock.calls[0][0] as Array<
      CreateRunGroundingInput & Record<string, unknown>
    >;
    expect(persisted).toEqual({
      ...run,
      repoRole: 'target',
      ...targetPin,
      groundedAt,
    });
    expect(persisted).not.toHaveProperty('credentials');
    expect(persisted).not.toHaveProperty('checkoutPath');
    expect(repository.deactivateByRun).toHaveBeenCalledWith(run);
  });
});
