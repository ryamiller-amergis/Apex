import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalBuildPreviewLaunchService,
  installGoldenStackPreviewAdapter,
  type LocalPreviewLaunchTarget,
} from '../buildLocalPreviewLaunchService';

const target: LocalPreviewLaunchTarget = {
  buildRunId: 'build-1',
  revisionId: 'revision-1',
  revisionNumber: 2,
  project: 'Apex',
  repository: 'generated-app',
  requesterUserId: 'user-1',
  supportContacts: [{ userId: 'user-1' }],
  integrationBranch: 'apex/build-1',
  validatedCommit: 'a'.repeat(40),
  previewRolloutMode: 'live',
  runStatus: 'deployment_failed',
  deploymentStatus: 'failed',
  hasActivePreview: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dependencies(
  overrides: Partial<
    Parameters<typeof createLocalBuildPreviewLaunchService>[0]
  > = {}
) {
  return {
    isAvailable: () => true,
    loadTarget: jest.fn().mockResolvedValue(target),
    activateTarget: jest.fn().mockResolvedValue({
      kind: 'activated' as const,
      pipelineRunId: 'local-preview:revision-1',
      expiresAt: '2026-11-07T00:00:00.000Z',
    }),
    prepareRuntime: jest.fn().mockResolvedValue({
      digest: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 123,
      blobRef: {
        container: 'local-preview-runtime',
        key: 'revision-1/runtime.tar',
      },
      bundlePath: 'C:\\preview\\runtime.tar',
      runnerImage: 'apex/full-stack-express-preview-runner:a'.concat(
        'a'.repeat(11)
      ),
      templateVersion: '1.0.0',
    }),
    prepareEditablePreview: jest.fn().mockResolvedValue({
      previewUrl: 'http://127.0.0.1:43123/',
    }),
    runPreview: jest.fn().mockResolvedValue({ kind: 'preview_ready' }),
    finalizeLease: jest.fn().mockResolvedValue(undefined),
    reportError: jest.fn(),
    ...overrides,
  };
}

describe('buildLocalPreviewLaunchService', () => {
  it('adapts an older Golden Stack revision without replacing app source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'preview-adapter-'));
    const workspace = path.join(root, 'workspace');
    const adapter = path.join(root, 'adapter');
    try {
      await Promise.all([
        mkdir(path.join(workspace, 'apps', 'api'), { recursive: true }),
        mkdir(path.join(workspace, 'apps', 'web'), { recursive: true }),
        mkdir(path.join(workspace, 'scripts'), { recursive: true }),
        mkdir(path.join(adapter, 'scripts', 'preview'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(workspace, 'package.json'), '{"name":"generated"}'),
        writeFile(
          path.join(workspace, 'apps', 'web', 'source.ts'),
          'exact app'
        ),
        writeFile(
          path.join(adapter, 'apex.preview.json'),
          '{"schemaVersion":1}'
        ),
        writeFile(path.join(adapter, 'Dockerfile.preview'), 'FROM scratch'),
        writeFile(
          path.join(adapter, 'scripts', 'preview', 'runtime.mjs'),
          'export {};'
        ),
      ]);

      await expect(
        installGoldenStackPreviewAdapter(workspace, adapter)
      ).resolves.toBe(true);
      await expect(
        readFile(path.join(workspace, 'apps', 'web', 'source.ts'), 'utf8')
      ).resolves.toBe('exact app');
      await expect(
        readFile(
          path.join(workspace, 'scripts', 'preview', 'runtime.mjs'),
          'utf8'
        )
      ).resolves.toBe('export {};');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects the trigger outside a local environment', async () => {
    const deps = dependencies({ isAvailable: () => false });
    const service = createLocalBuildPreviewLaunchService(deps);

    await expect(
      service.start({
        buildRunId: 'build-1',
        project: 'Apex',
        actor: { userId: 'user-1', isProjectAdmin: false, isSuperAdmin: false },
      })
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(deps.loadTarget).not.toHaveBeenCalled();
  });

  it('does not expose a build from another project', async () => {
    const deps = dependencies();
    const service = createLocalBuildPreviewLaunchService(deps);

    await expect(
      service.start({
        buildRunId: 'build-1',
        project: 'Other',
        actor: { userId: 'user-1', isProjectAdmin: true, isSuperAdmin: false },
      })
    ).resolves.toEqual({ kind: 'not_found' });
    expect(deps.activateTarget).not.toHaveBeenCalled();
  });

  it('requires the requester, a support contact, or an administrator', async () => {
    const deps = dependencies();
    const service = createLocalBuildPreviewLaunchService(deps);

    await expect(
      service.start({
        buildRunId: 'build-1',
        project: 'Apex',
        actor: { userId: 'user-2', isProjectAdmin: false, isSuperAdmin: false },
      })
    ).resolves.toEqual({ kind: 'forbidden' });
    expect(deps.activateTarget).not.toHaveBeenCalled();
  });

  it.each([
    [{ validatedCommit: null }, 'A validated revision is required.'],
    [{ integrationBranch: null }, 'The integration branch is unavailable.'],
    [{ runStatus: 'building' }, 'The build is not ready for a local preview.'],
    [{ deploymentStatus: 'succeeded' }, 'The revision already has a preview.'],
  ])('rejects an incompatible revision', async (change, message) => {
    const deps = dependencies({
      loadTarget: jest.fn().mockResolvedValue({ ...target, ...change }),
    });
    const service = createLocalBuildPreviewLaunchService(deps);

    await expect(
      service.start({
        buildRunId: 'build-1',
        project: 'Apex',
        actor: { userId: 'user-1', isProjectAdmin: false, isSuperAdmin: false },
      })
    ).resolves.toEqual({ kind: 'not_ready', message });
    expect(deps.activateTarget).not.toHaveBeenCalled();
  });

  it('starts a validated queued legacy revision in local Docker', async () => {
    const legacyTarget: LocalPreviewLaunchTarget = {
      ...target,
      previewRolloutMode: 'legacy_static',
      runStatus: 'deploying',
      deploymentStatus: 'queued',
    };
    const deps = dependencies({
      loadTarget: jest.fn().mockResolvedValue(legacyTarget),
    });
    const service = createLocalBuildPreviewLaunchService(deps);

    await expect(
      service.start({
        buildRunId: 'build-1',
        project: 'Apex',
        actor: { userId: 'user-1', isProjectAdmin: false, isSuperAdmin: false },
      })
    ).resolves.toEqual({ kind: 'started', revisionNumber: 2 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(deps.activateTarget).toHaveBeenCalledWith(legacyTarget);
    expect(deps.prepareRuntime).toHaveBeenCalledWith(legacyTarget);
    expect(deps.prepareEditablePreview).toHaveBeenCalledWith(legacyTarget);
    expect(deps.runPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        stablePreviewUrl: 'http://127.0.0.1:43123/',
      })
    );
    expect(deps.finalizeLease).toHaveBeenCalledWith(
      legacyTarget,
      '2026-11-07T00:00:00.000Z'
    );
  });

  it('starts exact-revision preparation in the background and blocks duplicates', async () => {
    const runtime =
      deferred<
        Awaited<ReturnType<ReturnType<typeof dependencies>['prepareRuntime']>>
      >();
    const deps = dependencies({
      prepareRuntime: jest.fn().mockReturnValue(runtime.promise),
    });
    const service = createLocalBuildPreviewLaunchService(deps);
    const request = {
      buildRunId: 'build-1',
      project: 'Apex',
      actor: {
        userId: 'user-1',
        isProjectAdmin: false,
        isSuperAdmin: false,
      },
    };

    await expect(service.start(request)).resolves.toEqual({
      kind: 'started',
      revisionNumber: 2,
    });
    await expect(service.start(request)).resolves.toEqual({
      kind: 'already_active',
    });
    expect(deps.prepareRuntime).toHaveBeenCalledWith(target);
    expect(deps.runPreview).not.toHaveBeenCalled();

    runtime.resolve({
      digest: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 123,
      blobRef: {
        container: 'local-preview-runtime',
        key: 'revision-1/runtime.tar',
      },
      bundlePath: 'C:\\preview\\runtime.tar',
      runnerImage: 'apex/full-stack-express-preview-runner:aaaaaaaaaaaa',
      templateVersion: '1.0.0',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(deps.runPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        target,
        pipelineRunId: 'local-preview:revision-1',
        stablePreviewUrl: 'http://127.0.0.1:43123/',
      })
    );
  });

  it('reports background failures without rejecting the accepted request', async () => {
    const error = new Error('Docker is unavailable');
    const deps = dependencies({
      prepareRuntime: jest.fn().mockRejectedValue(error),
    });
    const service = createLocalBuildPreviewLaunchService(deps);

    await expect(
      service.start({
        buildRunId: 'build-1',
        project: 'Apex',
        actor: { userId: 'user-1', isProjectAdmin: false, isSuperAdmin: false },
      })
    ).resolves.toEqual({ kind: 'started', revisionNumber: 2 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(deps.reportError).toHaveBeenCalledWith(target, error);
  });
});
