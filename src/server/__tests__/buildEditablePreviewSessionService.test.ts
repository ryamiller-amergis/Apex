import type {
  EditablePreviewSessionProvider,
  EditablePreviewSessionSnapshot,
  EditablePreviewTask,
  ProviderMutationResult,
} from '../services/build/buildPreviewProviderContracts';
import {
  createBuildEditablePreviewSessionService,
  type EditablePreviewRevisionTarget,
} from '../services/build/buildEditablePreviewSessionService';

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;
const CHANGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const BASE_COMMIT = 'd'.repeat(40);
const VALIDATED_COMMIT = 'e'.repeat(40);

const target: EditablePreviewRevisionTarget = {
  buildRunId: 'build-1',
  project: 'Apex',
  repository: 'generated-app',
  integrationBranch: 'apex/build/build-1',
  baseRevisionId: 'revision-1',
  draftRevisionId: 'revision-2',
  revisionNumber: 2,
  baseCommit: BASE_COMMIT,
  templateVersion: '1.0.0',
};

function accepted(handle?: string): ProviderMutationResult {
  return {
    ok: true,
    accepted: {
      operationId: 'operation-1',
      phase: 'accepted',
      ...(handle ? { handle } : {}),
    },
  };
}

function createProvider() {
  const handle = 'editable-session:build-1';
  let workspaceVersion = 0;
  let snapshot: EditablePreviewSessionSnapshot | null = null;
  const tasks: EditablePreviewTask[] = [];
  const provider: EditablePreviewSessionProvider = {
    start: jest.fn(async ({ spec }) => {
      snapshot = {
        spec,
        lifecycle: 'ready',
        workspace: {
          writable: true,
          version: 0,
          baseSnapshotDigest: spec.source.snapshotDigest,
          appliedChangeSets: [],
        },
        transport: {
          upstreamRef: 'docker-loopback:127.0.0.1:32789',
          checks: {
            http: 'ready',
            websocket: 'ready',
            vite_hmr: 'ready',
          },
        },
        expiresAt: spec.expiresAt,
        failureCode: null,
      };
      return accepted(handle);
    }),
    inspect: jest.fn(async () => ({
      handle,
      phase: 'succeeded' as const,
      snapshot,
      error: null,
      observedAt: '2026-11-06T17:00:00.000Z',
    })),
    applyChangeSet: jest.fn(async ({ changeSet }) => {
      workspaceVersion += 1;
      snapshot = {
        ...snapshot!,
        workspace: {
          ...snapshot!.workspace,
          version: workspaceVersion,
          appliedChangeSets: [
            ...snapshot!.workspace.appliedChangeSets,
            changeSet,
          ],
        },
      };
      return accepted(handle);
    }),
    runTask: jest.fn(async ({ task }) => {
      tasks.push(task);
      return accepted(handle);
    }),
    renew: jest.fn(async () => accepted(handle)),
    suspend: jest.fn(async () => accepted(handle)),
    resume: jest.fn(async () => accepted(handle)),
    destroy: jest.fn(async () => accepted(handle)),
  };
  return { provider, handle, tasks };
}

function createDeps() {
  const { provider, handle, tasks } = createProvider();
  const releaseSource = jest.fn().mockResolvedValue(undefined);
  const releaseChangeSet = jest.fn().mockResolvedValue(undefined);
  return {
    provider,
    handle,
    tasks,
    releaseSource,
    releaseChangeSet,
    dependencies: {
      isAvailable: () => true,
      provider,
      loadTarget: jest.fn().mockResolvedValue(target),
      materializeSource: jest.fn().mockResolvedValue({
        source: {
          snapshotDigest: SOURCE_DIGEST,
          snapshotRef: 'artifact:source-build-1',
        },
        developmentManifestDigest: MANIFEST_DIGEST,
        databaseGrantRef: 'grant:database-build-1',
        release: releaseSource,
      }),
      materializeChangeSet: jest.fn().mockResolvedValue({
        changeSet: {
          digest: CHANGE_DIGEST,
          contentRef: 'artifact:change-build-1-2',
        },
        release: releaseChangeSet,
      }),
      publishPreview: jest.fn().mockResolvedValue('http://127.0.0.1:32789/'),
      persistSession: jest.fn().mockResolvedValue(undefined),
      persistAppliedRevision: jest.fn().mockResolvedValue(undefined),
      appendEvent: jest.fn().mockResolvedValue(undefined),
      now: () => new Date('2026-11-06T17:00:00.000Z'),
      pollIntervalMs: 0,
      readinessTimeoutMs: 100,
    },
  };
}

describe('build editable preview session service', () => {
  it('primes the initial Studio URL without publishing it before preview verification', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService(deps.dependencies);

    await expect(
      service.beginRevision({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
        persistPreviewUrl: false,
      })
    ).resolves.toEqual({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 0,
    });

    expect(deps.dependencies.persistSession).not.toHaveBeenCalled();
  });

  it('starts one writable session and publishes its stable preview URL', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService(deps.dependencies);

    await expect(
      service.beginRevision({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
      })
    ).resolves.toEqual({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 0,
    });

    expect(deps.dependencies.provider.start).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          correlation: expect.objectContaining({
            buildRunId: target.buildRunId,
            baseRevisionId: target.baseRevisionId,
            draftRevisionId: target.draftRevisionId,
            baseCommit: BASE_COMMIT,
          }),
        }),
      })
    );
    expect(deps.dependencies.publishPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamRef: 'docker-loopback:127.0.0.1:32789',
      })
    );
    expect(deps.dependencies.persistSession).toHaveBeenCalledWith({
      target,
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 0,
    });
    expect(deps.releaseSource).toHaveBeenCalledTimes(1);
  });

  it('applies a validated revision, runs stable checks, and keeps the preview URL', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService(deps.dependencies);
    await service.beginRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
    });

    await expect(
      service.applyValidatedRevision({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
        validatedCommit: VALIDATED_COMMIT,
      })
    ).resolves.toEqual({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 1,
    });

    expect(deps.dependencies.materializeChangeSet).toHaveBeenCalledWith({
      target,
      validatedCommit: VALIDATED_COMMIT,
    });
    expect(deps.dependencies.provider.applyChangeSet).toHaveBeenCalledWith({
      idempotencyKey: `studio:${target.draftRevisionId}:${CHANGE_DIGEST}`,
      handle: deps.handle,
      expectedWorkspaceVersion: 0,
      changeSet: {
        digest: CHANGE_DIGEST,
        contentRef: 'artifact:change-build-1-2',
      },
    });
    expect(deps.tasks).toEqual(['typecheck', 'unit_test']);
    expect(deps.dependencies.persistAppliedRevision).toHaveBeenCalledWith({
      target,
      validatedCommit: VALIDATED_COMMIT,
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 1,
      changeSet: {
        digest: CHANGE_DIGEST,
        contentRef: 'artifact:change-build-1-2',
      },
    });
    expect(deps.releaseChangeSet).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent applications of the same validated revision', async () => {
    const deps = createDeps();
    let releaseMaterialization: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    const materialized =
      deps.dependencies.materializeChangeSet.getMockImplementation()!;
    deps.dependencies.materializeChangeSet.mockImplementation(async (input) => {
      await blocked;
      return materialized(input);
    });
    const service = createBuildEditablePreviewSessionService(deps.dependencies);
    await service.beginRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
    });

    const first = service.applyValidatedRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
      validatedCommit: VALIDATED_COMMIT,
    });
    const second = service.applyValidatedRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
      validatedCommit: VALIDATED_COMMIT,
    });
    releaseMaterialization?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'applied', workspaceVersion: 1 }),
      expect.objectContaining({ kind: 'applied', workspaceVersion: 1 }),
    ]);
    expect(deps.dependencies.materializeChangeSet).toHaveBeenCalledTimes(1);
    expect(deps.dependencies.provider.applyChangeSet).toHaveBeenCalledTimes(1);
  });

  it('reports post-apply check failures without saying the preview failed to apply', async () => {
    const deps = createDeps();
    (deps.dependencies.provider.runTask as jest.Mock).mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Unit tests failed.',
        retryable: true,
      },
    });
    const service = createBuildEditablePreviewSessionService(deps.dependencies);
    await service.beginRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
    });

    await expect(
      service.applyValidatedRevision({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
        validatedCommit: VALIDATED_COMMIT,
      })
    ).resolves.toMatchObject({ kind: 'failed' });

    expect(deps.dependencies.appendEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        eventType: 'studio.checks_failed',
        message: 'The editable preview updated, but its checks failed.',
      })
    );
  });

  it('applies a draft to the stable preview before any quality task runs', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService(deps.dependencies);
    await service.beginRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
    });

    await expect(
      service.applyDraftChangeSet({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
        expectedWorkspaceVersion: 0,
        changeSet: {
          digest: CHANGE_DIGEST,
          contentRef: 'artifact:change-build-1-2',
        },
      })
    ).resolves.toEqual({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 1,
    });

    expect(deps.dependencies.provider.applyChangeSet).toHaveBeenCalledTimes(1);
    expect(deps.dependencies.provider.runTask).not.toHaveBeenCalled();
    expect(deps.dependencies.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'studio.preview_updated',
        detail: expect.objectContaining({ workspaceVersion: 1 }),
      })
    );
  });

  it('runs draft checks only after apply and reports their summary', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService(deps.dependencies);
    await service.beginRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
    });
    await service.applyDraftChangeSet({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
      expectedWorkspaceVersion: 0,
      changeSet: {
        digest: CHANGE_DIGEST,
        contentRef: 'artifact:change-build-1-2',
      },
    });

    await expect(
      service.runDraftChecks({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
        workspaceVersion: 1,
      })
    ).resolves.toMatchObject({
      kind: 'completed',
      summary: {
        status: 'passed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          { name: 'unit_test', status: 'passed' },
        ],
      },
    });
  });

  it('keeps an applied draft available when a check fails', async () => {
    const deps = createDeps();
    (deps.dependencies.provider.runTask as jest.Mock).mockImplementation(
      async ({ task }: { task: EditablePreviewTask }) =>
        task === 'typecheck'
          ? accepted(deps.handle)
          : {
              ok: false,
              error: {
                code: 'internal_error',
                message: 'Unit tests failed.',
                retryable: true,
              },
            }
    );
    const service = createBuildEditablePreviewSessionService(deps.dependencies);
    await service.beginRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
    });
    await service.applyDraftChangeSet({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
      expectedWorkspaceVersion: 0,
      changeSet: {
        digest: CHANGE_DIGEST,
        contentRef: 'artifact:change-build-1-2',
      },
    });

    const result = await service.runDraftChecks({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
      workspaceVersion: 1,
    });

    expect(result).toMatchObject({
      kind: 'completed',
      previewUrl: 'http://127.0.0.1:32789/',
      summary: {
        status: 'failed',
        tasks: [
          { name: 'typecheck', status: 'passed' },
          {
            name: 'unit_test',
            status: 'failed',
            message: 'Unit tests failed.',
          },
        ],
      },
    });
  });

  it('reuses the same preview URL for the next draft revision', async () => {
    const deps = createDeps();
    const nextTarget: EditablePreviewRevisionTarget = {
      ...target,
      baseRevisionId: target.draftRevisionId,
      draftRevisionId: 'revision-3',
      revisionNumber: 3,
      baseCommit: VALIDATED_COMMIT,
    };
    deps.dependencies.loadTarget
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(nextTarget);
    const service = createBuildEditablePreviewSessionService(deps.dependencies);

    await service.beginRevision({
      buildRunId: target.buildRunId,
      draftRevisionId: target.draftRevisionId,
    });
    await expect(
      service.beginRevision({
        buildRunId: nextTarget.buildRunId,
        draftRevisionId: nextTarget.draftRevisionId,
      })
    ).resolves.toEqual({
      kind: 'ready',
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 0,
    });

    expect(deps.dependencies.provider.start).toHaveBeenCalledTimes(1);
    expect(deps.dependencies.persistSession).toHaveBeenLastCalledWith({
      target: nextTarget,
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 0,
    });
  });

  it('reconstructs a missing session before applying the validated revision', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService(deps.dependencies);

    await expect(
      service.applyValidatedRevision({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
        validatedCommit: VALIDATED_COMMIT,
      })
    ).resolves.toEqual({
      kind: 'applied',
      previewUrl: 'http://127.0.0.1:32789/',
      workspaceVersion: 1,
    });

    expect(deps.dependencies.provider.start).toHaveBeenCalledTimes(1);
    expect(deps.dependencies.materializeChangeSet).toHaveBeenCalledTimes(1);
  });

  it('returns no_session when the revision cannot be reconstructed', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService({
      ...deps.dependencies,
      loadTarget: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.applyValidatedRevision({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
        validatedCommit: VALIDATED_COMMIT,
      })
    ).resolves.toEqual({ kind: 'no_session' });

    expect(deps.dependencies.provider.start).not.toHaveBeenCalled();
  });

  it('leaves production revision flow available when Studio is unavailable', async () => {
    const deps = createDeps();
    const service = createBuildEditablePreviewSessionService({
      ...deps.dependencies,
      isAvailable: () => false,
    });

    await expect(
      service.beginRevision({
        buildRunId: target.buildRunId,
        draftRevisionId: target.draftRevisionId,
      })
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(deps.dependencies.loadTarget).not.toHaveBeenCalled();
  });
});
