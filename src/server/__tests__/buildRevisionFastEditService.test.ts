import {
  createBuildRevisionFastEditRepository,
  createInMemoryBuildRevisionFastEditStore,
} from '../services/build/buildRevisionFastEditRepository';
import { createBuildRevisionFastEditService } from '../services/build/buildRevisionFastEditService';
import type { BuildRevisionFastEditCheckSummary } from '../../shared/types/buildRevision';

const target = {
  buildRunId: 'build-1',
  buildRevisionId: 'revision-2',
  revisionNumber: 2,
  project: 'Apex',
  repository: 'generated-app',
  integrationBranch: 'apex/build/build-1',
  feedback: 'Move the Cancel button to the right.',
  baseCommit: 'a'.repeat(40),
  baseSnapshot: {
    digest: `sha256:${'b'.repeat(64)}`,
    ref: 'git:build-1:commit-a',
  },
  expectedWorkspaceVersion: 0,
  idempotencyKey: 'revision-2:fast-edit',
  requestDigest: `sha256:${'c'.repeat(64)}`,
  requestedAt: '2026-11-06T18:00:00.000Z',
  expiresAt: '2026-11-06T20:00:00.000Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createHarness() {
  const repository = createBuildRevisionFastEditRepository(
    createInMemoryBuildRevisionFastEditStore()
  );
  const order: string[] = [];
  const checks = deferred<{
    kind: 'completed';
    previewUrl: string;
    workspaceVersion: number;
    summary: {
      status: 'passed' | 'failed';
      tasks: Array<{
        name: 'typecheck' | 'unit_test';
        status: 'passed' | 'failed';
      }>;
    };
  }>();
  const dependencies = {
    repository,
    loadTarget: jest.fn().mockResolvedValue(target),
    classify: jest.fn().mockReturnValue({
      route: 'fast_edit',
      certain: true,
      reason: 'contained_ui_change',
      matchedSignals: ['layout'],
      agentMayEscalate: true,
    }),
    beginStudio: jest.fn(async () => ({
      kind: 'ready' as const,
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 0,
    })),
    prepareWorkspace: jest.fn(async () => ({
      workspacePath: 'C:\\scratch\\revision-2',
      release: jest.fn().mockResolvedValue(undefined),
    })),
    restoreWorkspace: jest.fn().mockResolvedValue(undefined),
    materializeRollback: jest.fn(async () => ({
      artifact: {
        digest: `sha256:${'f'.repeat(64)}`,
        ref: 'artifact:build-fast-edit:rollback-1',
      },
      changedPaths: ['apps/web/src/features/Card.tsx'],
      deletePaths: [],
      localPath: 'C:\\artifacts\\rollback-1',
    })),
    editAgent: {
      edit: jest.fn(async () => ({
        kind: 'edited' as const,
        agentCorrelationRef: 'agent:cursor-local:1',
      })),
    },
    stageApprovedAssets: jest.fn().mockResolvedValue(undefined),
    artifactStore: {
      materialize: jest.fn(async () => ({
        artifact: {
          digest: `sha256:${'d'.repeat(64)}`,
          ref: 'artifact:build-fast-edit:change-1',
        },
        changedPaths: ['apps/web/src/features/Card.tsx'],
        deletePaths: [],
        localPath: 'C:\\artifacts\\change-1',
      })),
      resolve: jest.fn(),
    },
    applyDraft: jest.fn(async () => {
      order.push('apply');
      return {
        kind: 'applied' as const,
        previewUrl: 'http://127.0.0.1:3100/',
        workspaceVersion: 1,
      };
    }),
    runChecks: jest.fn(async () => {
      order.push('checks_started');
      return checks.promise;
    }),
    checkpoint: jest.fn(async () => {
      order.push('checkpoint');
      return 'e'.repeat(40);
    }),
    markValidated: jest.fn(async () => {
      order.push('validated');
    }),
    markChecksFailed: jest.fn(async () => {
      order.push('failed');
    }),
    markExecutionFailed: jest.fn().mockResolvedValue(undefined),
    markRetryStarted: jest.fn().mockResolvedValue(undefined),
    escalate: jest.fn(async () => {
      order.push('escalated');
    }),
  };
  return {
    service: createBuildRevisionFastEditService(dependencies),
    dependencies,
    repository,
    checks,
    order,
  };
}

describe('build revision fast-edit service', () => {
  it('updates the warm preview before checks complete', async () => {
    const h = createHarness();
    const execution = h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(h.order).toEqual(['apply', 'checks_started']);
    expect(h.dependencies.checkpoint).not.toHaveBeenCalled();

    h.checks.resolve({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'passed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'passed' },
        ],
      },
    });
    await expect(execution).resolves.toMatchObject({ kind: 'ready' });
    expect(h.order).toEqual([
      'apply',
      'checks_started',
      'checkpoint',
      'validated',
    ]);
    expect(h.dependencies.markValidated).toHaveBeenCalledWith(
      target.buildRevisionId,
      'e'.repeat(40),
      { skipEditablePreviewApply: true, deferDeployment: true }
    );
  });

  it('stages an approved asset before materializing the preview change set', async () => {
    const h = createHarness();
    h.checks.resolve({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: { status: 'passed', tasks: [] },
    });

    await h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });

    expect(h.dependencies.stageApprovedAssets).toHaveBeenCalledWith({
      target,
      workspacePath: 'C:\\scratch\\revision-2',
    });
    expect(
      h.dependencies.stageApprovedAssets.mock.invocationCallOrder[0]
    ).toBeLessThan(
      h.dependencies.artifactStore.materialize.mock.invocationCallOrder[0]
    );
  });

  it('keeps the draft but does not checkpoint when checks fail', async () => {
    const h = createHarness();
    const execution = h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.checks.resolve({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'failed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'failed' },
        ],
      },
    });

    await expect(execution).resolves.toMatchObject({
      kind: 'checks_failed',
      previewUrl: 'http://127.0.0.1:3100/',
    });
    expect(h.dependencies.checkpoint).not.toHaveBeenCalled();
    expect(h.dependencies.markChecksFailed).toHaveBeenCalled();
  });

  it('escalates structural requests without starting or mutating Studio', async () => {
    const h = createHarness();
    h.dependencies.classify.mockReturnValue({
      route: 'full_build',
      certain: true,
      reason: 'structural_change',
      matchedSignals: ['api_contract'],
      agentMayEscalate: true,
    });

    await expect(
      h.service.execute({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
      })
    ).resolves.toMatchObject({ kind: 'escalated' });

    expect(h.dependencies.beginStudio).not.toHaveBeenCalled();
    expect(h.dependencies.editAgent.edit).not.toHaveBeenCalled();
    expect(h.dependencies.applyDraft).not.toHaveBeenCalled();
    expect(h.dependencies.escalate).toHaveBeenCalled();
  });

  it('rolls a failed draft back through a new change set and validates the base commit', async () => {
    const h = createHarness();
    const execution = h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.checks.resolve({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'failed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'failed' },
        ],
      },
    });
    const failed = await execution;
    if (failed.kind !== 'checks_failed') {
      throw new Error('Expected the first edit to fail checks.');
    }

    h.dependencies.beginStudio.mockResolvedValue({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
    });
    h.dependencies.applyDraft.mockResolvedValue({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 2,
    });
    h.dependencies.runChecks.mockResolvedValue({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 2,
      summary: {
        status: 'passed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'passed' },
        ],
      },
    });

    await expect(
      h.service.rollback({
        buildRunId: target.buildRunId,
        attemptId: failed.attemptId,
      })
    ).resolves.toMatchObject({
      kind: 'ready',
      validatedCommit: target.baseCommit,
      workspaceVersion: 2,
    });
    expect(h.dependencies.markValidated).toHaveBeenLastCalledWith(
      target.buildRevisionId,
      target.baseCommit,
      { skipEditablePreviewApply: true, deferDeployment: true }
    );
  });

  it('returns the build to a usable preview state when editing fails', async () => {
    const h = createHarness();
    h.dependencies.editAgent.edit.mockRejectedValue(
      new Error('Synthetic edit failure')
    );

    await expect(
      h.service.execute({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
      })
    ).resolves.toMatchObject({
      kind: 'failed',
      reason: 'Synthetic edit failure',
    });
    expect(h.dependencies.markExecutionFailed).toHaveBeenCalledWith({
      target,
      reason: 'Synthetic edit failure',
    });
  });

  it('continues on the cloud agent when the live preview is unavailable', async () => {
    const h = createHarness();
    const handOffToCloud = jest.fn().mockResolvedValue(undefined);
    const service = createBuildRevisionFastEditService({
      ...h.dependencies,
      handOffToCloud,
    });
    h.dependencies.beginStudio.mockResolvedValue({
      kind: 'failed',
      reason: 'Studio is not running.',
    } as never);

    await expect(
      service.execute({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
      })
    ).resolves.toMatchObject({ kind: 'failed' });

    expect(handOffToCloud).toHaveBeenCalledWith({
      target,
      reason: 'Studio is not running.',
    });
    expect(h.dependencies.markExecutionFailed).not.toHaveBeenCalled();
  });

  it('continues on the cloud agent when checks still fail after the repair pass', async () => {
    const h = createHarness();
    const handOffToCloud = jest.fn().mockResolvedValue(undefined);
    const service = createBuildRevisionFastEditService({
      ...h.dependencies,
      handOffToCloud,
    });
    h.dependencies.runChecks.mockResolvedValue({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'failed',
        tasks: [{ name: 'unit_test', status: 'failed', message: 'boom' }],
      },
    } as never);

    await expect(
      service.execute({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
      })
    ).resolves.toMatchObject({ kind: 'checks_failed' });

    expect(handOffToCloud).toHaveBeenCalledWith({
      target,
      reason: 'unit_test: boom',
    });
    expect(h.dependencies.markChecksFailed).not.toHaveBeenCalled();
  });

  it('replays the persisted failed draft before a retry edit', async () => {
    const h = createHarness();
    const execution = h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.checks.resolve({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'failed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'failed' },
        ],
      },
    });
    const failed = await execution;
    if (failed.kind !== 'checks_failed') {
      throw new Error('Expected the first edit to fail checks.');
    }
    h.dependencies.beginStudio.mockResolvedValue({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
    });
    h.dependencies.applyDraft.mockResolvedValue({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 2,
    });

    await h.service.retry({
      buildRunId: target.buildRunId,
      attemptId: failed.attemptId,
    });

    expect(h.dependencies.restoreWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({
          orderedChangeSets: [expect.objectContaining({ kind: 'edit' })],
        }),
      })
    );
    expect(h.dependencies.editAgent.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoveredDraft: true })
    );
  });

  it('repairs the existing draft once with the failing check output', async () => {
    const h = createHarness();
    const checks = (
      workspaceVersion: number,
      summary: BuildRevisionFastEditCheckSummary
    ) => ({
      kind: 'completed' as const,
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion,
      summary,
    });
    h.dependencies.runChecks
      .mockResolvedValueOnce(
        checks(1, {
          status: 'failed',
          tasks: [
            {
              name: 'typecheck',
              status: 'failed',
              message: "Cannot find module '@mui/icons-material/Nope'",
            },
          ],
        }) as never
      )
      .mockResolvedValueOnce(
        checks(2, {
          status: 'passed',
          tasks: [
            { name: 'typecheck', status: 'passed' },
            { name: 'unit_test', status: 'passed' },
          ],
        }) as never
      );
    h.dependencies.applyDraft
      .mockResolvedValueOnce({
        kind: 'applied',
        previewUrl: 'http://127.0.0.1:3100/',
        workspaceVersion: 1,
      })
      .mockResolvedValueOnce({
        kind: 'applied',
        previewUrl: 'http://127.0.0.1:3100/',
        workspaceVersion: 2,
      });

    await expect(
      h.service.execute({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
      })
    ).resolves.toMatchObject({ kind: 'ready', workspaceVersion: 2 });
    expect(h.dependencies.editAgent.edit).toHaveBeenCalledTimes(2);
    expect(h.dependencies.editAgent.edit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recoveredDraft: true,
        repairContext: expect.stringContaining('@mui/icons-material/Nope'),
      })
    );
    expect(h.dependencies.markChecksFailed).not.toHaveBeenCalled();
  });

  it('reruns checks without the agent after an infrastructure failure', async () => {
    const h = createHarness();
    h.dependencies.runChecks.mockRejectedValueOnce(
      new Error('Studio runner stopped.')
    );
    const failed = await h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });
    if (failed.kind !== 'failed') {
      throw new Error('Expected the first run to fail.');
    }
    h.dependencies.beginStudio.mockResolvedValue({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
    });
    h.dependencies.applyDraft.mockResolvedValue({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
    });
    h.dependencies.runChecks.mockResolvedValue({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'passed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'passed' },
        ],
      },
    });

    await expect(
      h.service.retry({
        buildRunId: target.buildRunId,
        attemptId: failed.attemptId,
      })
    ).resolves.toMatchObject({ kind: 'ready' });
    expect(h.dependencies.editAgent.edit).toHaveBeenCalledTimes(1);
  });

  it('rechecks an already-applied recovered draft without appending it again', async () => {
    const h = createHarness();
    const execution = h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.checks.resolve({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'failed',
        tasks: [{ name: 'unit_test', status: 'failed' }],
      },
    });
    const failed = await execution;
    if (failed.kind !== 'checks_failed') {
      throw new Error('Expected the first edit to fail checks.');
    }

    h.dependencies.beginStudio.mockResolvedValue({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
    });
    h.dependencies.applyDraft.mockResolvedValue({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
    });
    h.dependencies.runChecks.mockResolvedValue({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'passed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'passed' },
        ],
      },
    });

    await expect(
      h.service.retry({
        buildRunId: target.buildRunId,
        attemptId: failed.attemptId,
      })
    ).resolves.toMatchObject({
      kind: 'ready',
      workspaceVersion: 1,
    });
    const recovery = await h.repository.loadRecoveryPlan(failed.attemptId);
    expect(recovery?.orderedChangeSets).toHaveLength(1);
  });

  it('starts retry work without holding the request open through checks', async () => {
    const h = createHarness();
    const execution = h.service.execute({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.checks.resolve({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
      summary: {
        status: 'failed',
        tasks: [{ name: 'unit_test', status: 'failed' }],
      },
    });
    const failed = await execution;
    if (failed.kind !== 'checks_failed') {
      throw new Error('Expected the first edit to fail checks.');
    }
    h.dependencies.beginStudio.mockResolvedValue({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 1,
    });
    h.dependencies.applyDraft.mockResolvedValue({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:3100/',
      workspaceVersion: 2,
    });
    h.dependencies.runChecks.mockImplementation(
      () => new Promise(() => undefined)
    );

    await expect(
      h.service.startRetry({
        buildRunId: target.buildRunId,
        attemptId: failed.attemptId,
      })
    ).resolves.toEqual({
      kind: 'started',
      attemptId: failed.attemptId,
    });
    expect(h.dependencies.markRetryStarted).toHaveBeenCalledWith({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
    });
  });
});
