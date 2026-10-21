import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type {
  BundleRef,
  MaterializeResult,
  RepositoryIdentity,
} from '../../../shared/types/grounding';
import { isFeatureEnabled as evaluateFeatureFlag } from '../featureFlagService';
import { createGroundingTelemetry } from '../groundingTelemetry';
import { resolveGitRemote } from '../repoCacheService';
import { trackEvent } from '../telemetry';
import {
  bundleKey,
  checkoutBundleAtSha,
  defaultRunGit,
  GROUNDING_WORKSPACE_READY_MARKER,
  isReadyWorkspace,
  markWorkspaceReady,
  prepareEmptyDestination,
  safeSha,
  verifyHead,
  type GitRunner,
} from './bundleCheckout';

export {
  bundleKey,
  GROUNDING_BUNDLE_GIT_TIMEOUT_MS,
  GROUNDING_WORKSPACE_READY_MARKER,
  type GitRunner,
} from './bundleCheckout';

const FEATURE_FLAG = 'repo-grounding-workspace-profile';
const DEFAULT_CONTAINER = 'repo-grounding';

export type BundleStoreTelemetry = (
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>
) => void;

export interface RepairAndMaterializeInput {
  identity: RepositoryIdentity;
  destination: string;
}

export type RepairAndMaterialize = (
  input: RepairAndMaterializeInput
) => Promise<boolean>;

export interface GroundingBundleStore {
  bundleExists(identity: RepositoryIdentity): Promise<boolean>;
  uploadBundle(
    identity: RepositoryIdentity,
    temporaryBundlePath: string
  ): Promise<BundleRef>;
  rehydrate(
    identity: RepositoryIdentity,
    destination: string
  ): Promise<MaterializeResult>;
  /**
   * Restores the same bundle as an object-only mirror. `rehydrate` lays down a
   * working tree, which the repo-read service must not carry — it serves
   * cat-file/ls-tree/grep straight from the object database.
   */
  rehydrateBare(
    identity: RepositoryIdentity,
    destination: string
  ): Promise<MaterializeResult>;
}

export interface GroundingBundleStoreOptions {
  getContainerClient?: () => ContainerClient;
  containerName?: string;
  repairAndMaterialize: RepairAndMaterialize;
  runGit?: GitRunner;
  telemetry?: BundleStoreTelemetry;
  now?: () => number;
  downloadTimeoutMs?: number;
}

export const GROUNDING_BUNDLE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export class GroundingBundleAuthorizationError extends Error {
  readonly code = 'GROUNDING_BUNDLE_AUTHORIZATION_FAILED';

  constructor() {
    super('Grounding bundle storage authorization failed');
    this.name = 'GroundingBundleAuthorizationError';
  }
}

export function groundingCredentialMode(
  environment: NodeJS.ProcessEnv = process.env
): 'system-assigned-managed-identity' | 'default-azure-credential' {
  return environment.WEBSITE_SITE_NAME || environment.WEBSITE_INSTANCE_ID
    ? 'system-assigned-managed-identity'
    : 'default-azure-credential';
}

function resolveContainerClient(containerName: string): ContainerClient {
  const account = process.env.GROUNDING_BLOB_ACCOUNT_NAME?.trim();
  if (!account) {
    throw new Error(
      'GROUNDING_BLOB_ACCOUNT_NAME is required for grounding bundle storage'
    );
  }

  // AZURE_CLIENT_ID belongs to Apex application authentication, not the
  // system-assigned App Service identity granted access by Terraform.
  const credential =
    groundingCredentialMode() === 'system-assigned-managed-identity'
      ? new ManagedIdentityCredential()
      : new DefaultAzureCredential();
  const service = new BlobServiceClient(
    `https://${account}.blob.core.windows.net`,
    credential
  );
  return service.getContainerClient(containerName);
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isAuthorizationFailure(error: unknown): boolean {
  return (
    errorStatus(error) === 401 ||
    errorStatus(error) === 403 ||
    ['AuthorizationFailure', 'AuthenticationFailed'].includes(
      errorCode(error) ?? ''
    )
  );
}

function isConcurrentWinner(error: unknown): boolean {
  return errorStatus(error) === 409 || errorStatus(error) === 412;
}

function isMissingBlob(error: unknown): boolean {
  return errorStatus(error) === 404 || errorCode(error) === 'BlobNotFound';
}

// A bare repository has no `.git` subdirectory — its root is the git dir.
function bareReadyMarkerPath(destination: string): string {
  return join(destination, GROUNDING_WORKSPACE_READY_MARKER);
}

async function hasCommit(
  runGit: GitRunner,
  destination: string,
  expectedSha: string
): Promise<boolean> {
  try {
    // HEAD is not a reliable probe in a bare clone, so assert the commit itself.
    await runGit(['-C', destination, 'cat-file', '-e', `${expectedSha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function isReadyMirror(
  runGit: GitRunner,
  destination: string,
  expectedSha: string
): Promise<boolean> {
  try {
    const markedSha = (await readFile(bareReadyMarkerPath(destination), 'utf8'))
      .trim()
      .toLowerCase();
    return markedSha === expectedSha && await hasCommit(
      runGit,
      destination,
      expectedSha
    );
  } catch {
    return false;
  }
}

async function markMirrorReady(
  destination: string,
  expectedSha: string
): Promise<void> {
  await writeFile(bareReadyMarkerPath(destination), `${expectedSha}\n`, 'utf8');
}

export function createGroundingBundleStore(
  options: GroundingBundleStoreOptions
): GroundingBundleStore {
  const containerName =
    options.containerName ??
    process.env.GROUNDING_BLOB_CONTAINER_NAME?.trim() ??
    DEFAULT_CONTAINER;
  const getContainerClient =
    options.getContainerClient ?? (() => resolveContainerClient(containerName));
  const runGit = options.runGit ?? defaultRunGit;
  const telemetry = options.telemetry ?? trackEvent;
  const groundingOperations = createGroundingTelemetry(telemetry);
  const now = options.now ?? Date.now;
  const downloadTimeoutMs =
    options.downloadTimeoutMs ?? GROUNDING_BUNDLE_DOWNLOAD_TIMEOUT_MS;
  const downloadBundle = (key: string, path: string) =>
    getContainerClient()
      .getBlockBlobClient(key)
      .downloadToFile(path, 0, undefined, {
        abortSignal: AbortSignal.timeout(downloadTimeoutMs),
      });

  return {
    async bundleExists(identity) {
      const key = bundleKey(identity);
      try {
        return await getContainerClient().getBlockBlobClient(key).exists();
      } catch (error) {
        if (isAuthorizationFailure(error)) {
          throw new GroundingBundleAuthorizationError();
        }
        throw new Error('Grounding bundle lookup failed');
      }
    },

    async uploadBundle(identity, temporaryBundlePath) {
      const key = bundleKey(identity);
      try {
        const blob = getContainerClient().getBlockBlobClient(key);
        try {
          await blob.uploadFile(temporaryBundlePath, {
            conditions: { ifNoneMatch: '*' },
            blobHTTPHeaders: {
              blobContentType: 'application/x-git-bundle',
            },
          });
        } catch (error) {
          if (!isConcurrentWinner(error)) {
            if (isAuthorizationFailure(error)) {
              throw new GroundingBundleAuthorizationError();
            }
            throw new Error('Grounding bundle upload failed');
          }
        }
        return { container: containerName, key, sha: safeSha(identity.sha) };
      } finally {
        await rm(temporaryBundlePath, { force: true }).catch(() => undefined);
      }
    },

    async rehydrate(identity, destination) {
      const startedAt = now();
      const key = bundleKey(identity);
      const expectedSha = safeSha(identity.sha);
      const scratchDirectory = await mkdtemp(
        join(tmpdir(), 'apex-grounding-bundle-')
      );
      const downloadedBundle = join(scratchDirectory, 'snapshot.bundle');
      let fallbackReason:
        | 'bundle-missing'
        | 'bundle-corrupt'
        | 'repair-failed' = 'bundle-corrupt';
      let destinationOwned = false;

      try {
        try {
          const existing = await stat(destination);
          if (
            existing.isDirectory() &&
            (await readdir(destination)).length > 0 &&
            (await isReadyWorkspace(runGit, destination, expectedSha))
          ) {
            telemetry('grounding.workspace.reuse', { outcome: 'success' });
            telemetry(
              'grounding.bundle.materialization.duration',
              { source: 'workspace', outcome: 'success' },
              { durationMs: now() - startedAt }
            );
            return { status: 'materialized', source: 'workspace' };
          }
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }

        await prepareEmptyDestination(destination);
        destinationOwned = true;

        try {
          await downloadBundle(key, downloadedBundle);
          telemetry('grounding.bundle.lookup', { outcome: 'hit' });
          groundingOperations.bundle(
            { caller: 'bundle-store', project: 'system' },
            true
          );

          await checkoutBundleAtSha({
            runGit,
            bundlePath: downloadedBundle,
            scratchDirectory,
            destination,
            expectedSha,
          });

          telemetry(
            'grounding.bundle.materialization.duration',
            { source: 'bundle', outcome: 'success' },
            { durationMs: now() - startedAt }
          );
          return { status: 'materialized', source: 'bundle' };
        } catch (error) {
          if (isAuthorizationFailure(error)) {
            throw new GroundingBundleAuthorizationError();
          }
          fallbackReason = isMissingBlob(error)
            ? 'bundle-missing'
            : 'bundle-corrupt';
          telemetry('grounding.bundle.lookup', {
            outcome: fallbackReason === 'bundle-missing' ? 'miss' : 'corrupt',
          });
          groundingOperations.bundle(
            { caller: 'bundle-store', project: 'system' },
            false
          );
          if (destinationOwned) {
            await rm(destination, { recursive: true, force: true }).catch(
              () => undefined
            );
          }
        }

        telemetry('grounding.bundle.repair', { outcome: 'invoked' });
        try {
          const repaired = await options.repairAndMaterialize({
            identity,
            destination,
          });
          if (
            repaired &&
            (await verifyHead(runGit, destination, expectedSha))
          ) {
            await markWorkspaceReady(destination, expectedSha);
            telemetry('grounding.bundle.repair', { outcome: 'succeeded' });
            telemetry(
              'grounding.bundle.materialization.duration',
              { source: 'repair', outcome: 'success' },
              { durationMs: now() - startedAt }
            );
            return { status: 'materialized', source: 'repair' };
          }
          telemetry('grounding.bundle.repair', { outcome: 'failed' });
        } catch {
          telemetry('grounding.bundle.repair', { outcome: 'failed' });
          fallbackReason = 'repair-failed';
        }

        await rm(destination, { recursive: true, force: true }).catch(
          () => undefined
        );
        telemetry('grounding.bundle.fallback', { reason: fallbackReason });
        telemetry(
          'grounding.bundle.materialization.duration',
          { source: 'fallback', outcome: 'failed' },
          { durationMs: now() - startedAt }
        );
        return { status: 'remote-fallback', reason: fallbackReason };
      } finally {
        await rm(scratchDirectory, { recursive: true, force: true }).catch(
          () => undefined
        );
      }
    },

    async rehydrateBare(identity, destination) {
      const startedAt = now();
      const key = bundleKey(identity);
      const expectedSha = safeSha(identity.sha);
      const scratchDirectory = await mkdtemp(
        join(tmpdir(), 'apex-grounding-mirror-')
      );
      const downloadedBundle = join(scratchDirectory, 'snapshot.bundle');

      try {
        if (await isReadyMirror(runGit, destination, expectedSha)) {
          telemetry('grounding.workspace.reuse', {
            outcome: 'success',
            shape: 'bare',
          });
          telemetry(
            'grounding.bundle.materialization.duration',
            { source: 'workspace', outcome: 'success', shape: 'bare' },
            { durationMs: now() - startedAt }
          );
          return { status: 'materialized', source: 'workspace' };
        }

        await prepareEmptyDestination(destination);

        try {
          await downloadBundle(key, downloadedBundle);
          telemetry('grounding.bundle.lookup', {
            outcome: 'hit',
            shape: 'bare',
          });
          groundingOperations.bundle(
            { caller: 'repo-read-service', project: identity.project },
            true
          );

          const verificationRepo = join(scratchDirectory, 'verify.git');
          await runGit(['init', '--bare', verificationRepo]);
          await runGit([
            '-C',
            verificationRepo,
            'bundle',
            'verify',
            downloadedBundle,
          ]);

          await runGit(['clone', '--bare', downloadedBundle, destination]);
          try {
            const remote = resolveGitRemote(
              identity.provider,
              identity.project,
              identity.repo,
            );
            await runGit([
              '-C',
              destination,
              'remote',
              'set-url',
              'origin',
              remote.url,
            ]);
          } catch {
            // Pin-fetch uses the configured remote URL even if origin stays stale.
          }
          if (!(await hasCommit(runGit, destination, expectedSha))) {
            throw new Error('Grounding bundle SHA verification failed');
          }
          await markMirrorReady(destination, expectedSha);

          telemetry(
            'grounding.bundle.materialization.duration',
            { source: 'bundle', outcome: 'success', shape: 'bare' },
            { durationMs: now() - startedAt }
          );
          return { status: 'materialized', source: 'bundle' };
        } catch (error) {
          if (isAuthorizationFailure(error)) {
            throw new GroundingBundleAuthorizationError();
          }
          const reason = isMissingBlob(error)
            ? 'bundle-missing'
            : 'bundle-corrupt';
          telemetry('grounding.bundle.lookup', {
            outcome: reason === 'bundle-missing' ? 'miss' : 'corrupt',
            shape: 'bare',
          });
          groundingOperations.bundle(
            { caller: 'repo-read-service', project: identity.project },
            false
          );
          // A half-written mirror would fail every later read, and the caller
          // clones from the remote instead — leave nothing behind.
          await rm(destination, { recursive: true, force: true }).catch(
            () => undefined
          );
          telemetry('grounding.bundle.fallback', { reason, shape: 'bare' });
          telemetry(
            'grounding.bundle.materialization.duration',
            { source: 'fallback', outcome: 'failed', shape: 'bare' },
            { durationMs: now() - startedAt }
          );
          return { status: 'remote-fallback', reason };
        }
      } finally {
        await rm(scratchDirectory, { recursive: true, force: true }).catch(
          () => undefined
        );
      }
    },
  };
}

export interface MaterializeGroundingBundleInput {
  identity: RepositoryIdentity;
  destination: string;
  flagContext: {
    userId: string;
    project: string;
  };
}

export interface MaterializeGroundingBundleOptions {
  store: Pick<GroundingBundleStore, 'rehydrate'>;
  isFeatureEnabled?: typeof evaluateFeatureFlag;
}

export async function materializeGroundingBundle(
  input: MaterializeGroundingBundleInput,
  options: MaterializeGroundingBundleOptions
): Promise<MaterializeResult> {
  const featureEnabled = options.isFeatureEnabled ?? evaluateFeatureFlag;
  const enabled = await featureEnabled(FEATURE_FLAG, input.flagContext);

  // Retain the enabled branch after two stable sprints at full rollout.
  // @feature-flag:repo-grounding-workspace-profile start winner=enabled
  if (!enabled) {
    // @feature-flag:repo-grounding-workspace-profile disabled-start
    const result: MaterializeResult = {
      status: 'remote-fallback',
      reason: 'feature-disabled',
    };
    // @feature-flag:repo-grounding-workspace-profile disabled-end
    return result;
  }

  // @feature-flag:repo-grounding-workspace-profile enabled-start
  const result = await options.store.rehydrate(
    input.identity,
    input.destination
  );
  // @feature-flag:repo-grounding-workspace-profile enabled-end
  // @feature-flag:repo-grounding-workspace-profile end
  return result;
}
