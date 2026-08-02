import type { SkillProvider } from '../../shared/types/projectSettings';
import type {
  GroundingProfile,
  GroundingProfileId,
} from '../../shared/types/repoReader';
import type {
  ActivateRunGroundingsResult,
  RunGroundingService,
} from './runGroundingService';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import { isGroundingEnabledForCaller as evaluateGroundingFlag } from './featureFlagService';
import {
  groundingProfileResolver,
  type GroundingCallerContext,
  type GroundingProfileReauthorization,
  type GroundingProfileRegistration,
} from './groundingProfileResolver';
import { ensureRepoCache as ensureRepositoryCache } from './repoCacheService';
import {
  materializeRunGroundingWithPath,
  type RunGroundingMaterializationResult,
} from './runGroundingMaterializer';
import { runGroundingService } from './runGroundingService';
import { trackEvent as emitTelemetryEvent } from './telemetry';

export interface CallerRepository {
  provider: SkillProvider;
  repo: string;
  branch: string;
}

export interface StartCallerGroundingInput {
  caller: string;
  userId: string;
  run: RunRef;
  repository: CallerRepository;
  reauthorize: GroundingProfileReauthorization;
}

export interface LocalCallerGrounding {
  mode: 'local';
  cwd: string;
  profileId: GroundingProfileId;
  release(): Promise<void>;
}

export interface RemoteCallerGrounding {
  mode: 'remote';
  release(): Promise<void>;
}

export type CallerGroundingSelection =
  | LocalCallerGrounding
  | RemoteCallerGrounding;

type GroundingServiceDependency = Pick<
  RunGroundingService,
  'activateGroundings' | 'getGroundings' | 'markTerminalInactive'
>;

export interface CallerGroundingDependencies {
  isGroundingEnabledForCaller: typeof evaluateGroundingFlag;
  ensureRepoCache: (
    options: {
      provider: SkillProvider;
      project: string;
      repo: string;
      branch: string;
    },
  ) => Promise<{ baseSha: string }>;
  groundingService: GroundingServiceDependency;
  materialize: (
    grounding: RunGrounding,
    destination: RunRef,
  ) => Promise<RunGroundingMaterializationResult>;
  profiles: {
    registerConnectionProfile(
      input: GroundingProfileRegistration,
      caller: GroundingCallerContext,
      reauthorize: GroundingProfileReauthorization,
    ): GroundingProfile;
    revokeProfile(profileId: GroundingProfileId): void;
  };
  trackEvent: typeof emitTelemetryEvent;
}

function runRefKey(run: RunRef): string {
  return `${run.runType}:${run.runId}`;
}

function groundingProvider(provider: SkillProvider): RunGrounding['provider'] {
  return provider === 'ado' ? 'azure_devops' : 'github';
}

function profileProvider(
  provider: RunGrounding['provider'],
): SkillProvider {
  return provider === 'azure_devops' ? 'ado' : 'github';
}

function repositoryName(repository: CallerRepository): string {
  if (repository.provider !== 'github') return repository.repo;
  const name = repository.repo.split('/').pop();
  return name || repository.repo;
}

function activeTarget(groundings: RunGrounding[]): RunGrounding | undefined {
  return groundings.find(
    (grounding) => grounding.repoRole === 'target' && grounding.isActive,
  );
}

function activatedTarget(
  activation: ActivateRunGroundingsResult,
): RunGrounding | undefined {
  return activation.ok ? activeTarget(activation.groundings) : undefined;
}

export function createCallerGroundingService(
  dependencies: CallerGroundingDependencies,
): {
  start(input: StartCallerGroundingInput): Promise<CallerGroundingSelection>;
} {
  const remote = (): RemoteCallerGrounding => ({
    mode: 'remote',
    release: async () => undefined,
  });

  const fallback = (
    input: StartCallerGroundingInput,
    reason: string,
  ): RemoteCallerGrounding => {
    dependencies.trackEvent('grounding.fallback', {
      caller: input.caller,
      project: input.run.project,
      runId: input.run.runId,
      reason,
    });
    return remote();
  };

  const startLocal = async (
    input: StartCallerGroundingInput,
  ): Promise<CallerGroundingSelection> => {
    try {
      const repo = repositoryName(input.repository);
      const existing = activeTarget(
        await dependencies.groundingService.getGroundings(input.run),
      );
      let grounding = existing;

      if (!grounding) {
        const cache = await dependencies.ensureRepoCache({
          provider: input.repository.provider,
          project: input.run.project,
          repo,
          branch: input.repository.branch,
        });
        grounding = activatedTarget(
          await dependencies.groundingService.activateGroundings({
            run: input.run,
            target: {
              provider: groundingProvider(input.repository.provider),
              repository: repo,
              branch: input.repository.branch,
              groundedSha: cache.baseSha,
            },
          }),
        );
      }

      if (!grounding) return fallback(input, 'activation-unavailable');

      const materialized = await dependencies.materialize(grounding, input.run);
      if (
        materialized.state !== 'materialized' ||
        !materialized.workspacePath
      ) {
        return fallback(input, 'materialization-unavailable');
      }

      const callerContext: GroundingCallerContext = {
        userId: input.userId,
        runRef: runRefKey(input.run),
        project: input.run.project,
      };
      const profile = dependencies.profiles.registerConnectionProfile(
        {
          runRef: callerContext.runRef,
          provider: profileProvider(grounding.provider),
          project: grounding.project,
          repo,
          sha: grounding.groundedSha,
          checkoutPath: materialized.workspacePath,
        },
        callerContext,
        input.reauthorize,
      );

      let released = false;
      return {
        mode: 'local',
        cwd: materialized.workspacePath,
        profileId: profile.id,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await dependencies.groundingService.markTerminalInactive(input.run);
          } finally {
            dependencies.profiles.revokeProfile(profile.id);
          }
        },
      };
    } catch {
      return fallback(input, 'startup-failed');
    }
  };

  return {
    async start(input) {
      let enabled = false;
      let evaluationFailed = false;
      try {
        enabled = await dependencies.isGroundingEnabledForCaller(
          {
            userId: input.userId,
            project: input.run.project,
            caller: input.caller,
          },
          () => {
            evaluationFailed = true;
          },
        );
      } catch {
        evaluationFailed = true;
      }

      if (evaluationFailed) {
        return fallback(input, 'flag-evaluation-failed');
      }

      // Retain the enabled branch after two stable sprints at full rollout.
      // @feature-flag:repo-grounding-workspace-profile start winner=enabled
      if (!enabled) {
        // @feature-flag:repo-grounding-workspace-profile disabled-start
        const legacyRemote = remote();
        // @feature-flag:repo-grounding-workspace-profile disabled-end
        return legacyRemote;
      }

      // @feature-flag:repo-grounding-workspace-profile enabled-start
      const local = await startLocal(input);
      // @feature-flag:repo-grounding-workspace-profile enabled-end
      // @feature-flag:repo-grounding-workspace-profile end
      return local;
    },
  };
}

export const callerGroundingService = createCallerGroundingService({
  isGroundingEnabledForCaller: evaluateGroundingFlag,
  ensureRepoCache: ensureRepositoryCache,
  groundingService: runGroundingService,
  materialize: materializeRunGroundingWithPath,
  profiles: groundingProfileResolver,
  trackEvent: emitTelemetryEvent,
});
