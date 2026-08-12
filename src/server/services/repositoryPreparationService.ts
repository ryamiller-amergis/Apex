import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import {
  sharedReadCheckoutService,
  type SharedReadCheckoutIdentity,
  type SharedReadCheckoutResult,
  type SharedReadCheckoutService,
} from './grounding/sharedReadCheckoutService';
import { ensureRepoCache, readCachedOriginSha } from './repoCacheService';
import {
  materializeRunGroundingWithPath,
  type RunGroundingMaterializationResult,
} from './runGroundingMaterializer';
import {
  type ActivateRunGroundingsResult,
  type RunGroundingService,
} from './runGroundingService';
import { sanitizeGroundingTelemetryProperties } from './groundingTelemetry';
import { trackEvent } from './telemetry';

export type RepositoryPreparationWorkflowClass =
  | 'agent-home'
  | 'interview'
  | 'adr'
  | 'ask-apex'
  | 'prd'
  | 'test-cases'
  | 'prd-validation'
  | 'design-doc'
  | 'design-doc-validation'
  | 'validation'
  | string;

export interface RepositoryPreparationTarget {
  provider: SkillProvider;
  project: string;
  repo: string;
  branch: string;
}

export interface ReadyReadOnlyRepository {
  identity: SharedReadCheckoutIdentity;
  checkout: SharedReadCheckoutResult;
}

export interface PrepareReadOnlyRepositoryInput {
  repository: RepositoryPreparationTarget;
  workflowClass: RepositoryPreparationWorkflowClass;
  sha?: string | null;
}

export interface PrepareWritableRepositoryInput {
  destinationRun: RunRef;
  workflowClass: RepositoryPreparationWorkflowClass;
  targetGrounding?: RunGrounding | null;
  repository?: RepositoryPreparationTarget | null;
}

type GroundingDependency = Pick<RunGroundingService, 'activateGroundings'>;

export interface RepositoryPreparationDependencies {
  readCachedOriginSha?: typeof readCachedOriginSha;
  ensureRepoCache?: (
    repository: RepositoryPreparationTarget
  ) => Promise<{ baseSha: string }>;
  sharedReadCheckout?: Pick<
    SharedReadCheckoutService,
    'getReady' | 'materialize'
  >;
  groundingService?: GroundingDependency;
  materializeWritable?: (
    grounding: RunGrounding,
    destination: RunRef
  ) => Promise<RunGroundingMaterializationResult>;
  telemetry?: typeof trackEvent;
  now?: () => number;
}

export interface RepositoryPreparationService {
  resolveCurrentSha(repository: RepositoryPreparationTarget): Promise<string>;
  getReadyReadOnly(
    input: PrepareReadOnlyRepositoryInput
  ): ReadyReadOnlyRepository | null;
  prepareReadOnly(
    input: PrepareReadOnlyRepositoryInput
  ): Promise<ReadyReadOnlyRepository>;
  prepareWritable(
    input: PrepareWritableRepositoryInput
  ): Promise<RunGroundingMaterializationResult & { grounding?: RunGrounding }>;
}

function groundingProvider(provider: SkillProvider): RunGrounding['provider'] {
  return provider === 'ado' ? 'azure_devops' : 'github';
}

function activatedTarget(
  activation: ActivateRunGroundingsResult
): RunGrounding | null {
  if (!activation.ok) return null;
  return (
    activation.groundings.find(
      (grounding) => grounding.repoRole === 'target' && grounding.isActive
    ) ?? null
  );
}

function isUsableTarget(
  grounding: RunGrounding | null | undefined,
  destination: RunRef
): grounding is RunGrounding {
  return Boolean(
    grounding &&
    grounding.repoRole === 'target' &&
    grounding.isActive &&
    grounding.project === destination.project &&
    grounding.groundedSha.trim().length > 0
  );
}

export function normalizePreparationRepository(
  repository: RepositoryPreparationTarget
): RepositoryPreparationTarget {
  if (repository.provider !== 'github') return repository;
  const repo =
    repository.repo.split('/').pop()?.trim() || repository.repo.trim();
  return { ...repository, repo };
}

export function createRepositoryPreparationService(
  dependencies: RepositoryPreparationDependencies = {}
): RepositoryPreparationService {
  const readCached = dependencies.readCachedOriginSha ?? readCachedOriginSha;
  const ensureCache = dependencies.ensureRepoCache ?? ensureRepoCache;
  const shared = dependencies.sharedReadCheckout ?? sharedReadCheckoutService;
  const activateGroundings =
    dependencies.groundingService?.activateGroundings ??
    (async (
      input: Parameters<GroundingDependency['activateGroundings']>[0]
    ) => {
      const { runGroundingService } = await import('./runGroundingService');
      return runGroundingService.activateGroundings(input);
    });
  const materializeWritable =
    dependencies.materializeWritable ?? materializeRunGroundingWithPath;
  const emit = dependencies.telemetry ?? trackEvent;
  const now = dependencies.now ?? Date.now;

  const safeTrack = (
    input: {
      workflowClass: RepositoryPreparationWorkflowClass;
      project: string;
      mode: 'shared-read' | 'writable-run';
      phase: 'on-demand-start' | 'ready' | 'failure';
      reason?: string;
    },
    durationMs: number
  ): void => {
    try {
      emit(
        'grounding.repository.preparation',
        sanitizeGroundingTelemetryProperties({
          workflowClass: input.workflowClass,
          project: input.project,
          mode: input.mode,
          phase: input.phase,
          reason: input.reason,
        }),
        { durationMs: Math.max(0, durationMs) }
      );
    } catch {
      // Preparation must not depend on telemetry availability.
    }
  };

  const identityFor = (
    repository: RepositoryPreparationTarget,
    sha: string
  ): SharedReadCheckoutIdentity => ({
    provider: repository.provider,
    project: repository.project,
    repo: repository.repo,
    branch: repository.branch,
    sha,
  });

  const resolveCurrentSha = async (
    rawRepository: RepositoryPreparationTarget
  ): Promise<string> => {
    const repository = normalizePreparationRepository(rawRepository);
    const cached = (
      await readCached({
        provider: groundingProvider(repository.provider),
        project: repository.project,
        repository: repository.repo,
        branch: repository.branch,
      }).catch(() => null)
    )?.trim();
    if (cached) return cached;

    const cache = await ensureCache(repository);
    const sha = cache.baseSha.trim();
    if (!sha) throw new Error('Repository mirror did not resolve a commit');
    return sha;
  };

  const getReadyReadOnly = (
    input: PrepareReadOnlyRepositoryInput
  ): ReadyReadOnlyRepository | null => {
    const repository = normalizePreparationRepository(input.repository);
    const sha = input.sha?.trim();
    if (!sha) return null;
    const identity = identityFor(repository, sha);
    const checkout = shared.getReady(identity);
    return checkout ? { identity, checkout } : null;
  };

  const prepareReadOnly = async (
    input: PrepareReadOnlyRepositoryInput
  ): Promise<ReadyReadOnlyRepository> => {
    const repository = normalizePreparationRepository(input.repository);
    const startedAt = now();
    safeTrack(
      {
        workflowClass: input.workflowClass,
        project: repository.project,
        mode: 'shared-read',
        phase: 'on-demand-start',
      },
      0
    );
    try {
      const sha = input.sha?.trim() || (await resolveCurrentSha(repository));
      const identity = identityFor(repository, sha);
      const checkout = await shared.materialize(identity);
      safeTrack(
        {
          workflowClass: input.workflowClass,
          project: repository.project,
          mode: 'shared-read',
          phase: 'ready',
        },
        now() - startedAt
      );
      return { identity, checkout };
    } catch (error) {
      safeTrack(
        {
          workflowClass: input.workflowClass,
          project: repository.project,
          mode: 'shared-read',
          phase: 'failure',
          reason: 'preparation-failed',
        },
        now() - startedAt
      );
      throw error;
    }
  };

  const prepareWritable = async (
    input: PrepareWritableRepositoryInput
  ): Promise<
    RunGroundingMaterializationResult & { grounding?: RunGrounding }
  > => {
    const startedAt = now();
    safeTrack(
      {
        workflowClass: input.workflowClass,
        project: input.destinationRun.project,
        mode: 'writable-run',
        phase: 'on-demand-start',
      },
      0
    );

    try {
      let grounding = input.targetGrounding;
      if (!isUsableTarget(grounding, input.destinationRun)) {
        if (!input.repository) {
          throw new Error('Repository target is unavailable');
        }
        const repository = normalizePreparationRepository(input.repository);
        const sha = await resolveCurrentSha(repository);
        grounding = activatedTarget(
          await activateGroundings({
            run: input.destinationRun,
            target: {
              provider: groundingProvider(repository.provider),
              repository: repository.repo,
              branch: repository.branch,
              groundedSha: sha,
            },
          })
        );
      }
      if (!isUsableTarget(grounding, input.destinationRun)) {
        throw new Error('Repository target could not be activated');
      }

      const result = await materializeWritable(
        grounding,
        input.destinationRun,
      );
      if (result.state !== 'materialized' || !result.workspacePath) {
        safeTrack(
          {
            workflowClass: input.workflowClass,
            project: input.destinationRun.project,
            mode: 'writable-run',
            phase: 'failure',
            reason: 'materialization-unavailable',
          },
          now() - startedAt
        );
        return { ...result, grounding };
      }
      safeTrack(
        {
          workflowClass: input.workflowClass,
          project: input.destinationRun.project,
          mode: 'writable-run',
          phase: 'ready',
        },
        now() - startedAt
      );
      return { ...result, grounding };
    } catch (error) {
      safeTrack(
        {
          workflowClass: input.workflowClass,
          project: input.destinationRun.project,
          mode: 'writable-run',
          phase: 'failure',
          reason: 'preparation-failed',
        },
        now() - startedAt
      );
      throw error;
    }
  };

  return {
    resolveCurrentSha,
    getReadyReadOnly,
    prepareReadOnly,
    prepareWritable,
  };
}

export const repositoryPreparationService =
  createRepositoryPreparationService();
