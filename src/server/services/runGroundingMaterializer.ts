import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type {
  RunGrounding,
  RunRef,
} from '../../shared/types/runGrounding';
import { git, safeArgs } from '../utils/asyncGit';
import { resolveDataRoot } from '../utils/dataDir';
import {
  createGroundingBundleStore,
  type GroundingBundleStore,
  type GroundingBundleStoreOptions,
} from './grounding/bundleStoreService';
import { ensureRepoCache } from './repoCacheService';
import { materializeWorkspaceFromCache } from './repoWorkspaceService';

type MaterializationState = 'materialized' | 'unavailable';

export interface RunGroundingMaterializationResult {
  state: MaterializationState;
  workspacePath?: string;
}

export interface GroundingMaterializerDependencies {
  dataRoot?: string;
  createBundleStore?: (
    options: GroundingBundleStoreOptions,
  ) => Pick<GroundingBundleStore, 'rehydrate'>;
  ensureRepoCache?: typeof ensureRepoCache;
  materializeWorkspaceFromCache?: typeof materializeWorkspaceFromCache;
  runGit?: typeof git;
}

function cacheProvider(provider: RunGrounding['provider']): SkillProvider {
  return provider === 'azure_devops' ? 'ado' : 'github';
}

function opaqueDestination(
  dataRoot: string,
  grounding: RunGrounding,
  destinationRun: RunRef,
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
  dataRoot = resolveDataRoot(),
): string {
  return opaqueDestination(dataRoot, grounding, destinationRun);
}

export function createRunGroundingMaterializer(
  dependencies: GroundingMaterializerDependencies = {},
): (
  grounding: RunGrounding,
  destinationRun: RunRef,
) => Promise<MaterializationState> {
  const dataRoot = dependencies.dataRoot ?? resolveDataRoot();
  const ensureCache = dependencies.ensureRepoCache ?? ensureRepoCache;
  const materializeFromCache =
    dependencies.materializeWorkspaceFromCache ??
    materializeWorkspaceFromCache;
  const runGit = dependencies.runGit ?? git;
  const branchesByDestination = new Map<string, string>();
  const createBundleStore =
    dependencies.createBundleStore ?? createGroundingBundleStore;
  const store = createBundleStore({
    repairAndMaterialize: async ({ identity, destination }) => {
      const branch = branchesByDestination.get(destination);
      if (!branch) return false;
      const cache = await ensureCache({
        provider: identity.provider,
        project: identity.project,
        repo: identity.repo,
        branch,
      });
      await materializeFromCache(
        cache.cacheDir,
        destination,
        branch,
        cache.remote.url,
      );
      await runGit(
        safeArgs(destination, ['checkout', '--detach', identity.sha]),
        { cwd: destination },
      );
      return true;
    },
  });

  return async (grounding, destinationRun) => {
    const destination = opaqueDestination(
      dataRoot,
      grounding,
      destinationRun,
    );
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
        destination,
      );
      return result.status === 'materialized'
        ? 'materialized'
        : 'unavailable';
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
  destinationRun: RunRef,
): Promise<RunGroundingMaterializationResult> {
  const state = await materializeRunGrounding(grounding, destinationRun);
  return state === 'materialized'
    ? {
        state,
        workspacePath: resolveRunGroundingWorkspacePath(
          grounding,
          destinationRun,
        ),
      }
    : { state };
}
