import { execFile } from 'child_process';
import { mkdtemp, readdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import type {
  BundleKey,
  BundleRef,
  MaterializeResult,
  RepositoryIdentity,
} from '../../../shared/types/grounding';
import { isFeatureEnabled as evaluateFeatureFlag } from '../featureFlagService';
import { createGroundingTelemetry } from '../groundingTelemetry';
import { trackEvent } from '../telemetry';

const execFileAsync = promisify(execFile);
const FEATURE_FLAG = 'repo-grounding-workspace-profile';
const DEFAULT_CONTAINER = 'repo-grounding';

export type BundleStoreTelemetry = (
  name: string,
  properties?: Record<string, string>,
  measurements?: Record<string, number>
) => void;

export type GitRunner = (
  args: string[],
  options?: { cwd?: string }
) => Promise<string>;

export interface RepairAndMaterializeInput {
  identity: RepositoryIdentity;
  destination: string;
}

export type RepairAndMaterialize = (
  input: RepairAndMaterializeInput
) => Promise<boolean>;

export interface GroundingBundleStore {
  uploadBundle(
    identity: RepositoryIdentity,
    temporaryBundlePath: string
  ): Promise<BundleRef>;
  rehydrate(
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
}

export class GroundingBundleAuthorizationError extends Error {
  readonly code = 'GROUNDING_BUNDLE_AUTHORIZATION_FAILED';

  constructor() {
    super('Grounding bundle storage authorization failed');
    this.name = 'GroundingBundleAuthorizationError';
  }
}

function safeSegment(value: string, label: string): string {
  const segment = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  if (!segment || segment === '.' || segment === '..') {
    throw new Error(`Invalid repository ${label}`);
  }
  return segment;
}

function safeSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) {
    throw new Error('Invalid repository SHA');
  }
  return sha;
}

export function groundingCredentialMode(
  environment: NodeJS.ProcessEnv = process.env
): 'system-assigned-managed-identity' | 'default-azure-credential' {
  return environment.WEBSITE_SITE_NAME || environment.WEBSITE_INSTANCE_ID
    ? 'system-assigned-managed-identity'
    : 'default-azure-credential';
}

export function bundleKey(identity: RepositoryIdentity): BundleKey {
  const provider = safeSegment(String(identity.provider), 'provider');
  const project = safeSegment(identity.project, 'project');
  const repo = safeSegment(identity.repo, 'repo');
  const sha = safeSha(identity.sha);
  return `${provider}/${project}/${repo}/${sha}.bundle` as BundleKey;
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

const defaultRunGit: GitRunner = async (args, options) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: options?.cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
};

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

async function prepareEmptyDestination(destination: string): Promise<void> {
  try {
    const existing = await stat(destination);
    if (!existing.isDirectory() || (await readdir(destination)).length > 0) {
      throw new Error('Grounding destination must be an empty directory');
    }
    await rm(destination, { recursive: true, force: true });
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

async function verifyHead(
  runGit: GitRunner,
  destination: string,
  expectedSha: string
): Promise<boolean> {
  const head = (await runGit(['-C', destination, 'rev-parse', 'HEAD']))
    .trim()
    .toLowerCase();
  return head === expectedSha;
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

  return {
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
        await prepareEmptyDestination(destination);
        destinationOwned = true;

        try {
          const blob = getContainerClient().getBlockBlobClient(key);
          await blob.downloadToFile(downloadedBundle);
          telemetry('grounding.bundle.lookup', { outcome: 'hit' });
          groundingOperations.bundle(
            { caller: 'bundle-store', project: 'system' },
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

          await runGit([
            'clone',
            '--no-checkout',
            downloadedBundle,
            destination,
          ]);
          await runGit([
            '-C',
            destination,
            'checkout',
            '--detach',
            expectedSha,
          ]);
          if (!(await verifyHead(runGit, destination, expectedSha))) {
            throw new Error('Grounding bundle SHA verification failed');
          }

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
