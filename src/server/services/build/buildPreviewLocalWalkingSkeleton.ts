import type { ArtifactRef } from '../../../shared/types/build';
import type {
  BrowserVerificationOutcome,
  BrowserVerificationRequest,
} from './buildPreviewBrowserVerifier';
import type {
  ApexPreviewCorrelation,
  ProviderErrorCode,
  ProviderInspectResult,
  ProviderMutationResult,
  SandboxDataProvider,
  SandboxDataSnapshot,
  SandboxProvider,
  SandboxSnapshot,
} from './buildPreviewProviderContracts';

export interface LocalPreviewRuntimeBundle {
  digest: string;
  sizeBytes: number;
  blobRef: ArtifactRef;
}

export interface LocalPreviewRevision {
  buildRunId: string;
  revisionId: string;
  revisionNumber: number;
  commit: string;
  templateVersion: string;
  runtimeBundle: LocalPreviewRuntimeBundle;
  expiresAt: string;
  pipelineRunId: string;
}

export interface LocalPreviewInstanceStore {
  begin(input: LocalPreviewRevision): Promise<{
    artifactId: string;
    instanceId: string;
  }>;
  listCleanupCandidates(revisionId: string): Promise<
    Array<{
      instanceId: string;
      dataHandle: string;
      sandboxHandle: string;
    }>
  >;
  recordDataHandle(input: {
    instanceId: string;
    dataHandle: string;
    operationId: string;
  }): Promise<void>;
  recordSandboxHandle(input: {
    instanceId: string;
    sandboxHandle: string;
    operationId: string;
  }): Promise<void>;
  markVerifying(instanceId: string): Promise<void>;
  markReady(instanceId: string): Promise<void>;
  markFailed(input: { instanceId: string; failureCode: string }): Promise<void>;
  markCleanup(input: {
    instanceId: string;
    status: 'running' | 'complete' | 'failed';
  }): Promise<void>;
}

interface BrowserVerifier {
  verify(
    input: BrowserVerificationRequest
  ): Promise<BrowserVerificationOutcome>;
}

interface PreviewSettlement {
  applied: boolean;
  reason?: string;
}

export type LocalPreviewWalkingSkeletonOutcome =
  | {
      kind: 'preview_ready';
      artifactId: string;
      instanceId: string;
      browserCheckId: string;
      previewUrl: string;
    }
  | {
      kind: 'blocked';
      artifactId: string;
      instanceId: string;
      browserCheckId: string | null;
      reason: string;
      previewUrl: string;
    }
  | {
      kind: 'failed';
      artifactId: string;
      instanceId: string;
      stage: 'database' | 'sandbox';
      failureCode: string;
    };

export function createLocalBuildPreviewWalkingSkeleton(dependencies: {
  store: LocalPreviewInstanceStore;
  data: SandboxDataProvider;
  sandbox: SandboxProvider;
  browserVerifier: BrowserVerifier;
  /**
   * Runs after browser evidence passes and before the preview is settled.
   * Throwing here fails the instance and cleans it up.
   */
  onPreviewVerified?(input: { instanceId: string }): Promise<void>;
  settlePreview(input: {
    pipelineRunId: string;
    commit: string;
    status: 'succeeded';
    previewUrl: string;
  }): Promise<PreviewSettlement>;
  sleep?: (ms: number) => Promise<void>;
  maxPollAttempts?: number;
  pollIntervalMs?: number;
  journeyVersion?: string;
}) {
  const sleep =
    dependencies.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxPollAttempts = dependencies.maxPollAttempts ?? 180;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 500;
  const journeyVersion =
    dependencies.journeyVersion ?? 'full-stack-express:profile:v1';

  return {
    async run(
      input: LocalPreviewRevision
    ): Promise<LocalPreviewWalkingSkeletonOutcome> {
      const cleanupAbandonedInstances = async (): Promise<void> => {
        const candidates = await dependencies.store.listCleanupCandidates(
          input.revisionId
        );
        for (const abandoned of candidates) {
          let cleanupFailed = false;
          try {
            await dependencies.store.markCleanup({
              instanceId: abandoned.instanceId,
              status: 'running',
            });
          } catch {
            cleanupFailed = true;
          }
          try {
            const result = await dependencies.sandbox.destroy({
              idempotencyKey: `${abandoned.instanceId}:sandbox:destroy`,
              handle: abandoned.sandboxHandle,
            });
            cleanupFailed ||= !result.ok;
          } catch {
            cleanupFailed = true;
          }
          try {
            const result = await dependencies.data.destroy({
              idempotencyKey: `${abandoned.instanceId}:data:destroy`,
              databaseHandle: abandoned.dataHandle,
            });
            cleanupFailed ||= !result.ok;
          } catch {
            cleanupFailed = true;
          }
          try {
            await dependencies.store.markCleanup({
              instanceId: abandoned.instanceId,
              status: cleanupFailed ? 'failed' : 'complete',
            });
          } catch {
            // Cleanup was attempted; a later run can retry the durable task.
          }
        }
      };
      await cleanupAbandonedInstances();
      const persisted = await dependencies.store.begin(input);
      await cleanupAbandonedInstances();
      const correlation = {
        previewInstanceId: persisted.instanceId,
        buildRunId: input.buildRunId,
        revisionId: input.revisionId,
        revisionNumber: input.revisionNumber,
        validatedCommit: input.commit,
        templateVersion: input.templateVersion,
      };
      let dataHandle: string | null = null;
      let sandboxHandle: string | null = null;

      const cleanupFailedPreview = async (): Promise<void> => {
        let cleanupFailed = false;
        try {
          await dependencies.store.markCleanup({
            instanceId: persisted.instanceId,
            status: 'running',
          });
        } catch {
          cleanupFailed = true;
        }
        if (sandboxHandle) {
          try {
            const result = await dependencies.sandbox.destroy({
              idempotencyKey: `${persisted.instanceId}:sandbox:destroy`,
              handle: sandboxHandle,
            });
            cleanupFailed ||= !result.ok;
          } catch {
            cleanupFailed = true;
          }
        }
        if (dataHandle) {
          try {
            const result = await dependencies.data.destroy({
              idempotencyKey: `${persisted.instanceId}:data:destroy`,
              databaseHandle: dataHandle,
            });
            cleanupFailed ||= !result.ok;
          } catch {
            cleanupFailed = true;
          }
        }
        try {
          await dependencies.store.markCleanup({
            instanceId: persisted.instanceId,
            status: cleanupFailed ? 'failed' : 'complete',
          });
        } catch {
          // Resource cleanup was still attempted; reconciliation can repair the row.
        }
      };

      const failProvider = async (
        stage: 'database' | 'sandbox',
        failureCode: ProviderErrorCode | 'timeout'
      ): Promise<LocalPreviewWalkingSkeletonOutcome> => {
        await dependencies.store.markFailed({
          instanceId: persisted.instanceId,
          failureCode,
        });
        await cleanupFailedPreview();
        return {
          kind: 'failed',
          artifactId: persisted.artifactId,
          instanceId: persisted.instanceId,
          stage,
          failureCode,
        };
      };

      try {
        const databaseCreated = await dependencies.data.create({
          idempotencyKey: `${persisted.instanceId}:data:create`,
          correlation,
          expiresAt: input.expiresAt,
        });
        const databaseAccepted = accepted(databaseCreated);
        if (!databaseAccepted) {
          console.error(
            '[local-preview] database create failed:',
            databaseCreated.ok
              ? { code: 'invalid_provider_response' }
              : databaseCreated.error
          );
          return await failProvider(
            'database',
            mutationFailureCode(databaseCreated)
          );
        }
        dataHandle = databaseAccepted.handle;
        await dependencies.store.recordDataHandle({
          instanceId: persisted.instanceId,
          dataHandle: databaseAccepted.handle,
          operationId: databaseAccepted.operationId,
        });

        const databaseMigrating = await poll(
          maxPollAttempts,
          pollIntervalMs,
          sleep,
          () =>
            dependencies.data.inspect({
              databaseHandle: databaseAccepted.handle,
            }),
          (result) => result.snapshot?.phase === 'migrating'
        );
        if (!databaseMigrating.ok) {
          return await failProvider('database', databaseMigrating.failureCode);
        }
        if (
          !matchesDataIdentity(
            databaseMigrating.value,
            databaseAccepted.handle,
            null,
            null
          )
        ) {
          return await failProvider('database', 'internal_error');
        }

        const migrated = await dependencies.data.migrate({
          idempotencyKey: `${persisted.instanceId}:data:migrate`,
          databaseHandle: databaseAccepted.handle,
          migrationArtifactDigest: input.runtimeBundle.digest,
        });
        if (!migrated.ok) {
          console.error(
            '[local-preview] database migration failed:',
            migrated.error
          );
          return await failProvider('database', migrated.error.code);
        }
        const seeded = await dependencies.data.seed({
          idempotencyKey: `${persisted.instanceId}:data:seed`,
          databaseHandle: databaseAccepted.handle,
          seedRecipeDigest: input.runtimeBundle.digest,
        });
        if (!seeded.ok) {
          console.error('[local-preview] database seed failed:', seeded.error);
          return await failProvider('database', seeded.error.code);
        }

        const databaseReady = await poll(
          maxPollAttempts,
          pollIntervalMs,
          sleep,
          () =>
            dependencies.data.inspect({
              databaseHandle: databaseAccepted.handle,
            }),
          (result) => result.snapshot?.phase === 'ready'
        );
        if (!databaseReady.ok) {
          return await failProvider('database', databaseReady.failureCode);
        }
        if (
          !matchesDataIdentity(
            databaseReady.value,
            databaseAccepted.handle,
            input.runtimeBundle.digest,
            input.runtimeBundle.digest
          )
        ) {
          return await failProvider('database', 'internal_error');
        }

        const sandboxCreated = await dependencies.sandbox.provision({
          idempotencyKey: `${persisted.instanceId}:sandbox:provision`,
          spec: {
            correlation,
            artifactDigest: input.runtimeBundle.digest,
            runtimeBundleDigest: input.runtimeBundle.digest,
            expiresAt: input.expiresAt,
            policy: {
              egress: 'denied',
              maxRuntimeSeconds: 7200,
            },
          },
        });
        const sandboxAccepted = accepted(sandboxCreated);
        if (!sandboxAccepted) {
          console.error(
            '[local-preview] sandbox provision failed:',
            sandboxCreated.ok
              ? { code: 'invalid_provider_response' }
              : sandboxCreated.error
          );
          return await failProvider(
            'sandbox',
            mutationFailureCode(sandboxCreated)
          );
        }
        sandboxHandle = sandboxAccepted.handle;
        await dependencies.store.recordSandboxHandle({
          instanceId: persisted.instanceId,
          sandboxHandle: sandboxAccepted.handle,
          operationId: sandboxAccepted.operationId,
        });

        const sandboxReady = await poll(
          maxPollAttempts,
          pollIntervalMs,
          sleep,
          () =>
            dependencies.sandbox.inspect({ handle: sandboxAccepted.handle }),
          (result) =>
            result.snapshot?.lifecycle === 'running' &&
            result.snapshot.applicationTarget !== null
        );
        if (!sandboxReady.ok) {
          return await failProvider('sandbox', sandboxReady.failureCode);
        }
        if (!sandboxReady.value.snapshot?.applicationTarget) {
          return await failProvider('sandbox', 'internal_error');
        }
        if (
          !matchesSandboxIdentity(
            sandboxReady.value,
            sandboxAccepted.handle,
            correlation,
            input.runtimeBundle.digest
          )
        ) {
          return await failProvider('sandbox', 'internal_error');
        }

        const previewUrl = dockerLoopbackUrl(
          sandboxReady.value.snapshot.applicationTarget.upstreamRef
        );
        await dependencies.store.markVerifying(persisted.instanceId);

        let browser: BrowserVerificationOutcome | null = null;
        try {
          browser = await dependencies.browserVerifier.verify({
            revisionId: input.revisionId,
            instanceId: persisted.instanceId,
            commit: input.commit,
            artifactDigest: input.runtimeBundle.digest,
            targetUrl: previewUrl,
            journeyVersion,
          });
        } catch {
          await dependencies.store.markFailed({
            instanceId: persisted.instanceId,
            failureCode: 'browser_verification',
          });
        }

        if (browser?.status === 'passed') {
          await dependencies.store.markReady(persisted.instanceId);
          await dependencies.onPreviewVerified?.({
            instanceId: persisted.instanceId,
          });
        } else if (browser) {
          await dependencies.store.markFailed({
            instanceId: persisted.instanceId,
            failureCode: 'browser_verification',
          });
        }

        let settlement: PreviewSettlement;
        try {
          settlement = await dependencies.settlePreview({
            pipelineRunId: input.pipelineRunId,
            commit: input.commit,
            status: 'succeeded',
            previewUrl,
          });
        } finally {
          if (!browser || browser.status !== 'passed') {
            await cleanupFailedPreview();
          }
        }
        if (browser?.status === 'passed' && settlement.applied) {
          return {
            kind: 'preview_ready',
            artifactId: persisted.artifactId,
            instanceId: persisted.instanceId,
            browserCheckId: browser.checkId,
            previewUrl,
          };
        }
        if (!browser || browser.status !== 'passed') {
          if (settlement.applied) {
            throw new Error(
              'Preview settlement applied without passing browser evidence.'
            );
          }
        }
        return {
          kind: 'blocked',
          artifactId: persisted.artifactId,
          instanceId: persisted.instanceId,
          browserCheckId: browser?.checkId ?? null,
          reason: settlement.reason ?? 'preview_evidence_pending',
          previewUrl,
        };
      } catch (error) {
        try {
          await dependencies.store.markFailed({
            instanceId: persisted.instanceId,
            failureCode: 'orchestration_error',
          });
        } catch {
          // Preserve the original error and still attempt provider cleanup.
        }
        await cleanupFailedPreview();
        throw error;
      }
    },
  };
}

function accepted(result: ProviderMutationResult): {
  handle: string;
  operationId: string;
} | null {
  if (!result.ok || !result.accepted.handle) return null;
  return {
    handle: result.accepted.handle,
    operationId: result.accepted.operationId,
  };
}

function mutationFailureCode(
  result: ProviderMutationResult
): ProviderErrorCode {
  return result.ok ? 'internal_error' : result.error.code;
}

function matchesDataIdentity(
  result: ProviderInspectResult<SandboxDataSnapshot>,
  expectedHandle: string,
  expectedMigrationDigest: string | null,
  expectedSeedChecksum: string | null
): boolean {
  return (
    result.handle === expectedHandle &&
    result.snapshot?.databaseHandle === expectedHandle &&
    result.snapshot.migrationDigest === expectedMigrationDigest &&
    result.snapshot.seedChecksum === expectedSeedChecksum
  );
}

function matchesSandboxIdentity(
  result: ProviderInspectResult<SandboxSnapshot>,
  expectedHandle: string,
  correlation: ApexPreviewCorrelation,
  artifactDigest: string
): boolean {
  const snapshot = result.snapshot;
  const actual = snapshot?.spec.correlation;
  return (
    result.handle === expectedHandle &&
    snapshot?.spec.artifactDigest === artifactDigest &&
    snapshot.spec.runtimeBundleDigest === artifactDigest &&
    actual?.previewInstanceId === correlation.previewInstanceId &&
    actual.buildRunId === correlation.buildRunId &&
    actual.revisionId === correlation.revisionId &&
    actual.revisionNumber === correlation.revisionNumber &&
    actual.validatedCommit === correlation.validatedCommit &&
    actual.templateVersion === correlation.templateVersion
  );
}

async function poll<
  T extends {
    phase: string;
    snapshot: unknown;
    error: { code: ProviderErrorCode; retryable: boolean } | null;
  },
>(
  attempts: number,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
  inspect: () => Promise<T>,
  ready: (value: T) => boolean
): Promise<
  | { ok: true; value: T }
  | { ok: false; failureCode: ProviderErrorCode | 'timeout' }
> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await inspect();
    if (value.phase === 'failed' || (value.error && !value.error.retryable)) {
      return {
        ok: false,
        failureCode: value.error?.code ?? 'internal_error',
      };
    }
    if (ready(value)) return { ok: true, value };
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  return { ok: false, failureCode: 'timeout' };
}

function dockerLoopbackUrl(upstreamRef: string): string {
  const match = /^docker-loopback:(127\.0\.0\.1|localhost):([0-9]+)$/.exec(
    upstreamRef
  );
  const port = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Local preview returned an invalid loopback target.');
  }
  return `http://${match[1]}:${port}`;
}
