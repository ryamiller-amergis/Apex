import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import { git, safeArgs } from '../utils/asyncGit';
import { resolveDataRoot } from '../utils/dataDir';
import {
  createGroundingBundleStore,
  type GroundingBundleStore,
  type GroundingBundleStoreOptions,
} from './grounding/bundleStoreService';
import {
  groundingBundlePublisher,
  type GroundingBundlePublisher,
} from './grounding/groundingBundlePublisherService';
import {
  ensureRepoCache,
  repairRepoCache,
  type RepoCacheResult,
} from './repoCacheService';
import { redactSecrets } from './repoCheckoutService';
import { materializeWorkspaceFromCache } from './repoWorkspaceService';
import { trackEvent } from './telemetry';

type MaterializationState = 'materialized' | 'unavailable';

export interface RunGroundingMaterializationResult {
  state: MaterializationState;
  workspacePath?: string;
}

export interface GroundingMaterializerDependencies {
  dataRoot?: string;
  createBundleStore?: (
    options: GroundingBundleStoreOptions
  ) => Pick<GroundingBundleStore, 'rehydrate'>;
  ensureRepoCache?: typeof ensureRepoCache;
  repairRepoCache?: typeof repairRepoCache;
  materializeWorkspaceFromCache?: typeof materializeWorkspaceFromCache;
  runGit?: typeof git;
  publishBundle?: GroundingBundlePublisher['publish'];
  telemetry?: typeof trackEvent;
}

function cacheProvider(provider: RunGrounding['provider']): SkillProvider {
  return provider === 'azure_devops' ? 'ado' : 'github';
}

function opaqueDestination(
  dataRoot: string,
  grounding: RunGrounding,
  destinationRun: RunRef
): string {
  const identity = JSON.stringify([
    destinationRun.runType,
    destinationRun.runId,
    destinationRun.project,
    grounding.repoRole,
    grounding.provider,
    grounding.repository,
    grounding.branch,
    grounding.groundedSha,
  ]);
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  return path.join(dataRoot, 'grounding-workspaces', digest);
}

/**
 * Returns the opaque, server-local destination for a run grounding. The path
 * is never transported to clients; callers receive it only as Agent.local.cwd.
 */
export function resolveRunGroundingWorkspacePath(
  grounding: RunGrounding,
  destinationRun: RunRef,
  dataRoot = resolveDataRoot()
): string {
  return opaqueDestination(dataRoot, grounding, destinationRun);
}

export function createRunGroundingMaterializer(
  dependencies: GroundingMaterializerDependencies = {}
): (
  grounding: RunGrounding,
  destinationRun: RunRef
) => Promise<MaterializationState> {
  const dataRoot = dependencies.dataRoot ?? resolveDataRoot();
  const ensureCache = dependencies.ensureRepoCache ?? ensureRepoCache;
  const repairCache = dependencies.repairRepoCache ?? repairRepoCache;
  const materializeFromCache =
    dependencies.materializeWorkspaceFromCache ?? materializeWorkspaceFromCache;
  const runGit = dependencies.runGit ?? git;
  const telemetry = dependencies.telemetry ?? trackEvent;
  const branchesByDestination = new Map<string, string>();
  const createBundleStore =
    dependencies.createBundleStore ?? createGroundingBundleStore;
  const publishBundle =
    dependencies.publishBundle ??
    ((input) => groundingBundlePublisher.publish(input));
  const store = createBundleStore({
    repairAndMaterialize: async ({ identity, destination }) => {
      const branch = branchesByDestination.get(destination);
      if (!branch) return false;
      const cacheOptions = {
        provider: identity.provider,
        project: identity.project,
        repo: identity.repo,
        branch,
      } as const;
      const materializePinnedSha = async (
        cache: Pick<RepoCacheResult, 'cacheDir' | 'remote'>
      ): Promise<void> => {
        await materializeFromCache(
          cache.cacheDir,
          destination,
          branch,
          cache.remote.url
        );
        await runGit(
          safeArgs(destination, ['checkout', '--detach', identity.sha]),
          { cwd: destination }
        );
      };
      const publishFromCache = (
        cache: Pick<RepoCacheResult, 'cacheDir'>
      ): void => {
        void Promise.resolve()
          .then(() =>
            publishBundle({
              identity,
              cacheDir: cache.cacheDir,
              branch,
            })
          )
          .then((outcome) => {
            telemetry('grounding.bundle.publish', {
              provider: String(identity.provider),
              project: identity.project,
              repository: redactSecrets(identity.repo),
              branch,
              outcome,
            });
          })
          .catch(() => {
            telemetry('grounding.bundle.publish', {
              provider: String(identity.provider),
              project: identity.project,
              repository: redactSecrets(identity.repo),
              branch,
              outcome: 'failed',
            });
          });
      };

      const cache = await ensureCache(cacheOptions);
      try {
        await materializePinnedSha(cache);
        publishFromCache(cache);
        return true;
      } catch {
        try {
          const repairedCache = await repairCache(cacheOptions);
          await materializePinnedSha(repairedCache);
          publishFromCache(repairedCache);
          return true;
        } catch {
          telemetry('grounding.materialization.fallback', {
            provider: String(identity.provider),
            project: identity.project,
            repository: redactSecrets(identity.repo),
            branch,
            reason: 'pinned-sha-unavailable',
          });
          return false;
        }
      }
    },
  });

  return async (grounding, destinationRun) => {
    const destination = opaqueDestination(dataRoot, grounding, destinationRun);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    branchesByDestination.set(destination, grounding.branch);
    try {
      const result = await store.rehydrate(
        {
          provider: cacheProvider(grounding.provider),
          project: grounding.project,
          repo: grounding.repository,
          sha: grounding.groundedSha,
        },
        destination
      );
      return result.status === 'materialized' ? 'materialized' : 'unavailable';
    } catch {
      return 'unavailable';
    } finally {
      branchesByDestination.delete(destination);
    }
  };
}

export const materializeRunGrounding = createRunGroundingMaterializer();

export async function materializeRunGroundingWithPath(
  grounding: RunGrounding,
  destinationRun: RunRef
): Promise<RunGroundingMaterializationResult> {
  const state = await materializeRunGrounding(grounding, destinationRun);
  return state === 'materialized'
    ? {
        state,
        workspacePath: resolveRunGroundingWorkspacePath(
          grounding,
          destinationRun
        ),
      }
    : { state };
}
