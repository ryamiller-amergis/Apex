import type {
  ProviderMutationResult,
  SandboxDataProvider,
  SandboxProvider,
} from '../services/build/buildPreviewProviderContracts';
import {
  createLocalBuildPreviewWalkingSkeleton,
  type LocalPreviewInstanceStore,
} from '../services/build/buildPreviewLocalWalkingSkeleton';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function accepted(handle: string): ProviderMutationResult {
  return {
    ok: true,
    accepted: {
      operationId: `operation:${handle}`,
      phase: 'accepted',
      handle,
    },
  };
}

function input() {
  return {
    buildRunId: 'run-1',
    revisionId: 'revision-1',
    revisionNumber: 1,
    commit: COMMIT,
    templateVersion: '1.0.0',
    runtimeBundle: {
      digest: DIGEST,
      sizeBytes: 1234,
      blobRef: {
        container: 'local-preview-runtime',
        key: 'full-stack-express/runtime.tar',
      },
    },
    expiresAt: '2026-11-07T12:00:00.000Z',
    pipelineRunId: 'local-preview:revision-1',
  };
}

function createHarness(
  browserStatus: 'passed' | 'failed' = 'passed',
  options?: {
    databaseNeverReady?: boolean;
    maxPollAttempts?: number;
    sandboxIdentityMismatch?: boolean;
    sandboxProvisionThrows?: boolean;
    sandboxDestroyThrows?: boolean;
    sandboxContradictoryFailure?: boolean;
    markFailedThrows?: boolean;
    abandonedInstance?: boolean;
  }
) {
  const calls: string[] = [];
  let abandonedCleanupPending = options?.abandonedInstance ?? false;
  const store: LocalPreviewInstanceStore = {
    begin: async () => {
      calls.push('store.begin');
      return { artifactId: 'artifact-1', instanceId: 'instance-1' };
    },
    listCleanupCandidates: async () => {
      calls.push('store.cleanup.list');
      return abandonedCleanupPending
        ? [
            {
              instanceId: 'abandoned-instance',
              dataHandle: 'docker-db:abandoned-instance',
              sandboxHandle: 'docker-sandbox:abandoned-instance',
            },
          ]
        : [];
    },
    recordDataHandle: async () => {
      calls.push('store.data');
    },
    recordSandboxHandle: async () => {
      calls.push('store.sandbox');
    },
    markVerifying: async () => {
      calls.push('store.verifying');
    },
    markReady: async () => {
      calls.push('store.ready');
    },
    markFailed: async () => {
      calls.push('store.failed');
      if (options?.markFailedThrows) {
        throw new Error('failure state unavailable');
      }
    },
    markCleanup: async ({ status }) => {
      calls.push(`store.cleanup.${status}`);
      if (status === 'complete') abandonedCleanupPending = false;
    },
  };
  let dataInspections = 0;
  let dataSeeded = false;
  const data: SandboxDataProvider = {
    create: async () => {
      calls.push('data.create');
      return accepted('database-1');
    },
    inspect: async () => {
      calls.push('data.inspect');
      dataInspections += 1;
      const migrating =
        !options?.databaseNeverReady && dataInspections > 1 && !dataSeeded;
      const ready = !options?.databaseNeverReady && dataSeeded;
      return {
        handle: 'database-1',
        phase: ready ? 'succeeded' : 'running',
        snapshot: {
          phase: ready ? 'ready' : migrating ? 'migrating' : 'creating',
          databaseHandle: 'database-1',
          migrationDigest: ready ? DIGEST : null,
          seedChecksum: ready ? DIGEST : null,
          failureCode: null,
        },
        error: null,
        observedAt: '2026-11-06T12:00:00.000Z',
      };
    },
    migrate: async () => {
      calls.push('data.migrate');
      return accepted('database-1');
    },
    seed: async () => {
      calls.push('data.seed');
      dataSeeded = true;
      return accepted('database-1');
    },
    destroy: async () => {
      calls.push('data.destroy');
      return accepted('database-1');
    },
  };
  let sandboxInspections = 0;
  const sandbox: SandboxProvider = {
    provision: async () => {
      calls.push('sandbox.provision');
      if (options?.sandboxProvisionThrows) {
        throw new Error('sandbox unavailable');
      }
      return accepted('sandbox-1');
    },
    inspect: async () => {
      calls.push('sandbox.inspect');
      sandboxInspections += 1;
      const ready = sandboxInspections > 1;
      const contradictoryFailure =
        ready && options?.sandboxContradictoryFailure;
      return {
        handle: 'sandbox-1',
        phase: contradictoryFailure
          ? 'failed'
          : ready
            ? 'succeeded'
            : 'running',
        snapshot: {
          spec: {
            correlation: {
              previewInstanceId: 'instance-1',
              buildRunId: 'run-1',
              revisionId: options?.sandboxIdentityMismatch
                ? 'wrong-revision'
                : 'revision-1',
              revisionNumber: 1,
              validatedCommit: COMMIT,
              templateVersion: '1.0.0',
            },
            artifactDigest: DIGEST,
            runtimeBundleDigest: DIGEST,
            expiresAt: '2026-11-07T12:00:00.000Z',
            policy: { egress: 'denied', maxRuntimeSeconds: 7200 },
          },
          lifecycle: ready ? 'running' : 'starting',
          applicationTarget: !ready
            ? null
            : {
                upstreamRef: 'docker-loopback:127.0.0.1:49123',
                health: {
                  livenessPath: '/health/live',
                  readinessPath: '/health/ready',
                  applicationPort: 3000,
                },
              },
          bootstrapChannelRef: 'bootstrap-1',
          expiresAt: '2026-11-07T12:00:00.000Z',
          failureCode: null,
        },
        error: contradictoryFailure
          ? {
              code: 'internal_error' as const,
              message: 'provider failed after publishing a snapshot',
              retryable: false,
            }
          : null,
        observedAt: '2026-11-06T12:00:00.000Z',
      };
    },
    renew: async () => accepted('sandbox-1'),
    suspend: async () => accepted('sandbox-1'),
    resume: async () => accepted('sandbox-1'),
    destroy: async () => {
      calls.push('sandbox.destroy');
      if (options?.sandboxDestroyThrows) {
        throw new Error('sandbox cleanup failed');
      }
      return accepted('sandbox-1');
    },
  };
  const settleCalls: Array<{ previewUrl: string }> = [];

  return {
    calls,
    settleCalls,
    service: createLocalBuildPreviewWalkingSkeleton({
      store,
      data,
      sandbox,
      browserVerifier: {
        verify: async (request) => {
          calls.push('browser.verify');
          expect(request).toMatchObject({
            revisionId: 'revision-1',
            instanceId: 'instance-1',
            commit: COMMIT,
            artifactDigest: DIGEST,
            targetUrl: 'http://127.0.0.1:49123',
          });
          return {
            checkId: 'browser-check-1',
            status: browserStatus,
            evidenceRefs: [],
          };
        },
      },
      onPreviewVerified: async (request) => {
        calls.push('preview.verified');
        expect(request).toEqual({ instanceId: 'instance-1' });
      },
      settlePreview: async (request) => {
        calls.push('deployment.settle');
        settleCalls.push({ previewUrl: request.previewUrl });
        return browserStatus === 'passed'
          ? { applied: true }
          : { applied: false, reason: 'preview_evidence_pending' };
      },
      sleep: async () => undefined,
      maxPollAttempts: options?.maxPollAttempts ?? 3,
    }),
  };
}

describe('local build preview walking skeleton', () => {
  it('persists a real instance and reaches preview_ready only after browser evidence passes', async () => {
    const harness = createHarness('passed');

    await expect(harness.service.run(input())).resolves.toEqual({
      kind: 'preview_ready',
      artifactId: 'artifact-1',
      instanceId: 'instance-1',
      browserCheckId: 'browser-check-1',
      previewUrl: 'http://127.0.0.1:49123',
    });
    expect(harness.calls).toEqual([
      'store.cleanup.list',
      'store.begin',
      'store.cleanup.list',
      'data.create',
      'store.data',
      'data.inspect',
      'data.inspect',
      'data.migrate',
      'data.seed',
      'data.inspect',
      'sandbox.provision',
      'store.sandbox',
      'sandbox.inspect',
      'sandbox.inspect',
      'store.verifying',
      'browser.verify',
      'store.ready',
      'preview.verified',
      'deployment.settle',
    ]);
  });

  it('records a failed instance and leaves preview_ready blocked when browser evidence fails', async () => {
    const harness = createHarness('failed');

    await expect(harness.service.run(input())).resolves.toEqual({
      kind: 'blocked',
      artifactId: 'artifact-1',
      instanceId: 'instance-1',
      browserCheckId: 'browser-check-1',
      reason: 'preview_evidence_pending',
      previewUrl: 'http://127.0.0.1:49123',
    });
    expect(harness.calls).toContain('store.failed');
    expect(harness.calls).not.toContain('store.ready');
    expect(harness.calls).not.toContain('preview.verified');
    expect(harness.calls).toEqual(
      expect.arrayContaining([
        'deployment.settle',
        'store.cleanup.running',
        'sandbox.destroy',
        'data.destroy',
        'store.cleanup.complete',
      ])
    );
    expect(harness.settleCalls).toEqual([
      { previewUrl: 'http://127.0.0.1:49123' },
    ]);
  });

  it('does not settle a preview when a provider never becomes ready', async () => {
    const harness = createHarness('passed', {
      databaseNeverReady: true,
      maxPollAttempts: 1,
    });

    await expect(harness.service.run(input())).resolves.toMatchObject({
      kind: 'failed',
      stage: 'database',
    });
    expect(harness.calls).not.toContain('deployment.settle');
    expect(harness.calls).toEqual(
      expect.arrayContaining([
        'store.failed',
        'store.cleanup.running',
        'data.destroy',
        'store.cleanup.complete',
      ])
    );
  });

  it('rejects a ready provider snapshot with a different revision identity', async () => {
    const harness = createHarness('passed', {
      sandboxIdentityMismatch: true,
    });

    await expect(harness.service.run(input())).resolves.toMatchObject({
      kind: 'failed',
      stage: 'sandbox',
      failureCode: 'internal_error',
    });
    expect(harness.calls).not.toContain('browser.verify');
    expect(harness.calls).not.toContain('deployment.settle');
  });

  it('cleans the database when sandbox provisioning throws', async () => {
    const harness = createHarness('passed', {
      sandboxProvisionThrows: true,
    });

    await expect(harness.service.run(input())).rejects.toThrow(
      'sandbox unavailable'
    );
    expect(harness.calls).toEqual(
      expect.arrayContaining([
        'store.failed',
        'store.cleanup.running',
        'data.destroy',
        'store.cleanup.complete',
      ])
    );
  });

  it('continues database cleanup when sandbox cleanup throws', async () => {
    const harness = createHarness('failed', {
      sandboxDestroyThrows: true,
    });

    await expect(harness.service.run(input())).resolves.toMatchObject({
      kind: 'blocked',
    });
    expect(harness.calls).toContain('sandbox.destroy');
    expect(harness.calls).toContain('data.destroy');
    expect(harness.calls).toContain('store.cleanup.failed');
  });

  it('cleans provider resources when recording a failure throws', async () => {
    const harness = createHarness('passed', {
      databaseNeverReady: true,
      markFailedThrows: true,
    });

    await expect(harness.service.run(input())).rejects.toThrow(
      'failure state unavailable'
    );
    expect(harness.calls).toContain('data.destroy');
  });

  it('does not accept a ready snapshot from a failed provider operation', async () => {
    const harness = createHarness('passed', {
      sandboxContradictoryFailure: true,
    });

    await expect(harness.service.run(input())).resolves.toMatchObject({
      kind: 'failed',
      stage: 'sandbox',
      failureCode: 'internal_error',
    });
    expect(harness.calls).not.toContain('browser.verify');
    expect(harness.calls).not.toContain('deployment.settle');
  });

  it('cleans an expired abandoned instance before provisioning its replacement', async () => {
    const harness = createHarness('passed', { abandonedInstance: true });

    await expect(harness.service.run(input())).resolves.toMatchObject({
      kind: 'preview_ready',
    });
    expect(harness.calls.slice(0, 8)).toEqual([
      'store.cleanup.list',
      'store.cleanup.running',
      'sandbox.destroy',
      'data.destroy',
      'store.cleanup.complete',
      'store.begin',
      'store.cleanup.list',
      'data.create',
    ]);
  });
});
