/**
 * Root workflow fetch-and-pin for admin-managed repository checkouts.
 *
 * When `project-repository-checkout-readiness` is ON, new Agent Home / Interview /
 * ADR / Ask Apex roots call this instead of ensureRepoCache / on-demand cold prep.
 * Existing pins are resumed exactly — never advanced to a newer ready SHA.
 */
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import type { ActivateRunGroundingsResult, RunGroundingService } from './runGroundingService';
import { runGroundingService } from './runGroundingService';
import {
  fetchRepositoryTip,
  type RepoCacheOptions,
  type RepoCacheResult,
} from './repoCacheService';
import {
  sharedReadCheckoutService,
  type SharedReadCheckoutIdentity,
  type SharedReadCheckoutService,
} from './grounding/sharedReadCheckoutService';
import { trackEvent } from './telemetry';
import { listSkillConfigsForProject } from './projectSettingsService';
import { enqueueRepositoryCheckout } from './projectRepositoryCheckoutService';

export class ProjectRepositoryFetchError extends Error {
  readonly code = 'PROJECT_REPOSITORY_FETCH_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectRepositoryFetchError';
  }
}

export class ProjectRepositorySnapshotUnavailableError extends Error {
  readonly code = 'PROJECT_REPOSITORY_SNAPSHOT_UNAVAILABLE';

  constructor(message?: string) {
    super(
      message
        ?? 'Repository snapshot is not ready. Ask a project administrator to Refresh the configured repository in Project Settings, then retry.',
    );
    this.name = 'ProjectRepositorySnapshotUnavailableError';
  }
}

export interface RootPinRepository {
  provider: SkillProvider;
  project: string;
  repo: string;
  branch: string;
}

export interface PinProjectRepositoryRootInput {
  run: RunRef;
  repository: RootPinRepository;
  caller: string;
  /**
   * Active target grounding already bound to this run. When present with a SHA,
   * resume that exact pin — never fetch or advance to a newer tip.
   */
  existingGrounding?: RunGrounding | null;
}

export interface PinProjectRepositoryRootResult {
  sha: string;
  workspacePath: string;
  grounding: RunGrounding;
  identity: SharedReadCheckoutIdentity;
  fetched: boolean;
}

export interface ProjectRepositoryRootPinDependencies {
  fetchTip?: (options: RepoCacheOptions) => Promise<RepoCacheResult>;
  sharedReadCheckout?: Pick<
    SharedReadCheckoutService,
    'getReady' | 'materialize' | 'retain'
  >;
  groundingService?: Pick<RunGroundingService, 'activateGroundings'>;
  trackEvent?: typeof trackEvent;
  now?: () => number;
  onSnapshotMiss?: (identity: SharedReadCheckoutIdentity) => Promise<void>;
}

function groundingProvider(
  provider: SkillProvider,
): RunGrounding['provider'] {
  return provider === 'ado' ? 'azure_devops' : 'github';
}

function activatedTarget(
  activation: ActivateRunGroundingsResult,
): RunGrounding | undefined {
  if (!activation.ok) return undefined;
  return activation.groundings.find(
    (g) => g.repoRole === 'target' && g.isActive,
  );
}

function sanitizeFetchError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Authorization:\s*Basic\s+\S+/gi, 'Authorization: Basic [redacted]')
    .replace(/:[^/@\s]+@/g, ':[redacted]@')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]+\b/g, '[redacted]')
    .slice(0, 500);
}

async function defaultOnSnapshotMiss(
  identity: SharedReadCheckoutIdentity,
): Promise<void> {
  const configs = await listSkillConfigsForProject(identity.project);
  const match =
    configs.find(
      (config) =>
        (config.skillProvider ?? 'ado') === identity.provider
        && config.skillRepo.trim() === identity.repo.trim()
        && config.skillBranch.trim() === identity.branch.trim(),
    ) ?? configs.find((config) => config.isDefault);
  if (match?.id) {
    await enqueueRepositoryCheckout(match.id, { refresh: true });
  }
}

/**
 * Resume an exact pinned SHA, or fetch the tip and pin it for a new root run.
 * Never cold-clones. Never materializes on the request path. Never falls back
 * to an older SHA when fetch fails.
 */
export async function pinProjectRepositoryRoot(
  input: PinProjectRepositoryRootInput,
  dependencies: ProjectRepositoryRootPinDependencies = {},
): Promise<PinProjectRepositoryRootResult> {
  const fetchTip = dependencies.fetchTip ?? fetchRepositoryTip;
  const shared =
    dependencies.sharedReadCheckout ?? sharedReadCheckoutService;
  const groundingService =
    dependencies.groundingService ?? runGroundingService;
  const emit = dependencies.trackEvent ?? trackEvent;
  const now = dependencies.now ?? Date.now;
  const onSnapshotMiss = dependencies.onSnapshotMiss ?? defaultOnSnapshotMiss;

  const { repository, run, caller } = input;
  const existingSha = input.existingGrounding?.groundedSha?.trim() || null;

  const ensureSnapshot = async (
    sha: string,
  ): Promise<{ identity: SharedReadCheckoutIdentity; workspacePath: string }> => {
    const identity: SharedReadCheckoutIdentity = {
      provider: repository.provider,
      project: repository.project,
      repo: repository.repo,
      branch: repository.branch,
      sha,
    };
    const ready = shared.getReady(identity);
    if (ready) {
      shared.retain(identity);
      return { identity, workspacePath: ready.workspacePath };
    }
    await onSnapshotMiss(identity);
    throw new ProjectRepositorySnapshotUnavailableError();
  };

  if (existingSha && input.existingGrounding) {
    const { identity, workspacePath } = await ensureSnapshot(existingSha);
    return {
      sha: existingSha,
      workspacePath,
      grounding: input.existingGrounding,
      identity,
      fetched: false,
    };
  }

  const cacheOptions: RepoCacheOptions = {
    provider: repository.provider,
    project: repository.project,
    repo: repository.repo,
    branch: repository.branch,
  };

  const fetchStarted = now();
  let tipSha: string;
  try {
    const tip = await fetchTip(cacheOptions);
    tipSha = tip.baseSha.trim();
    if (!tipSha) {
      throw new Error('Incremental fetch did not resolve a tip SHA');
    }
    emit(
      'grounding.fast_fetch',
      {
        outcome: 'success',
        caller,
        project: repository.project,
        runId: run.runId,
        runType: run.runType,
      },
      { durationMs: now() - fetchStarted },
    );
  } catch (error) {
    const sanitized = sanitizeFetchError(error);
    emit(
      'grounding.fast_fetch',
      {
        outcome: 'failed',
        caller,
        project: repository.project,
        runId: run.runId,
        runType: run.runType,
        reason: sanitized.slice(0, 120),
      },
      { durationMs: now() - fetchStarted },
    );
    throw new ProjectRepositoryFetchError(
      sanitized ||
        'Repository tip fetch failed. Ask a project administrator to Refresh the configured repository, then retry.',
    );
  }

  const { identity, workspacePath } = await ensureSnapshot(tipSha);
  const grounding = activatedTarget(
    await groundingService.activateGroundings({
      run,
      target: {
        provider: groundingProvider(repository.provider),
        repository: repository.repo,
        branch: repository.branch,
        groundedSha: tipSha,
      },
    }),
  );

  if (!grounding || grounding.groundedSha !== tipSha) {
    throw new ProjectRepositoryFetchError(
      'Repository tip was fetched but could not be pinned for this workflow. Retry the request.',
    );
  }

  emit(
    'grounding.workflow_pin',
    {
      outcome: 'success',
      caller,
      project: repository.project,
      runId: run.runId,
      runType: run.runType,
      sha: tipSha.slice(0, 12),
    },
    { pinCount: 1 },
  );

  return {
    sha: tipSha,
    workspacePath,
    grounding,
    identity,
    fetched: true,
  };
}
