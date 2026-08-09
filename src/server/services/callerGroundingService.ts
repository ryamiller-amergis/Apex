import type { SkillProvider } from '../../shared/types/projectSettings';
import type {
  BindingContinuityDecision,
  GroundingBinding,
} from '../../shared/types/chat';
import type {
  GroundingProfile,
  GroundingProfileId,
} from '../../shared/types/repoReader';
import type { NativeReadCapabilityResult } from '../../shared/types/groundingOperations';
import type {
  ActivateRunGroundingsResult,
  RunGroundingService,
} from './runGroundingService';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import {
  isGroundingEnabledForCaller as evaluateGroundingFlag,
  isNativeReadEnabledForCaller as evaluateNativeReadFlag,
  isSharedReadCheckoutEnabledForCaller as evaluateSharedReadCheckoutFlag,
} from './featureFlagService';
import {
  sharedReadCheckoutService,
  type SharedReadCheckoutIdentity,
  type SharedReadCheckoutService,
} from './grounding/sharedReadCheckoutService';
import { evaluateNativeReadCapability as evaluateNativeReadCapabilityCheck } from './nativeReadCapabilityService';
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
import { createGroundingTelemetry } from './groundingTelemetry';
import {
  runImpactContextRegistry,
  type RunImpactContextRegistry,
} from './runImpactContextRegistry';

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
  /**
   * When true, the caller uses the grounding checkout strictly read-only (all
   * writes target a separate per-thread scratch dir). Such callers may share
   * one read-only per-SHA checkout instead of cloning a per-run working tree,
   * gated by the `shared-readonly-grounding-checkout` flag.
   */
  readOnlyShareable?: boolean;
}

export interface LocalCallerGrounding {
  mode: 'local';
  cwd: string;
  profileId: GroundingProfileId;
  resolvedSha: string;
  nativeReads: boolean;
  release(): Promise<void>;
}

export interface RemoteCallerGrounding {
  mode: 'remote';
  release(): Promise<void>;
}

export type CallerGroundingSelection =
  | LocalCallerGrounding
  | RemoteCallerGrounding;

export function callerGroundingSelectionToBinding(
  selection: CallerGroundingSelection
): GroundingBinding {
  return selection.mode === 'local'
    ? { mode: 'local', sha: selection.resolvedSha }
    : { mode: 'remote', sha: null };
}

function isValidGroundingBinding(value: unknown): value is GroundingBinding {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as { mode?: unknown; sha?: unknown };
  if (candidate.mode === 'local') {
    return typeof candidate.sha === 'string' && candidate.sha.trim().length > 0;
  }
  return candidate.mode === 'remote' && candidate.sha === null;
}

export function evaluateBindingContinuity(
  stored: unknown,
  resolved: GroundingBinding
): BindingContinuityDecision {
  if (stored == null) {
    return {
      decision: 'recreate',
      reason: 'legacy-binding-missing',
    };
  }
  if (!isValidGroundingBinding(stored)) {
    return { decision: 'recreate', reason: 'binding-malformed' };
  }
  if (stored.mode !== resolved.mode) {
    return { decision: 'recreate', reason: 'mode-changed' };
  }
  if (stored.mode === 'local' && resolved.mode === 'local') {
    return stored.sha === resolved.sha
      ? { decision: 'resume' }
      : { decision: 'recreate', reason: 'sha-changed' };
  }
  return { decision: 'resume' };
}

type GroundingServiceDependency = Pick<
  RunGroundingService,
  'activateGroundings' | 'getGroundings' | 'markTerminalInactive'
>;

export interface CallerGroundingDependencies {
  isGroundingEnabledForCaller: typeof evaluateGroundingFlag;
  isNativeReadEnabledForCaller: typeof evaluateNativeReadFlag;
  isSharedReadCheckoutEnabledForCaller: typeof evaluateSharedReadCheckoutFlag;
  evaluateNativeReadCapability: typeof evaluateNativeReadCapabilityCheck;
  sharedReadCheckout: Pick<
    SharedReadCheckoutService,
    'materialize' | 'retain' | 'releaseRef'
  >;
  ensureRepoCache: (options: {
    provider: SkillProvider;
    project: string;
    repo: string;
    branch: string;
  }) => Promise<{ baseSha: string; mirrorHit?: boolean }>;
  groundingService: GroundingServiceDependency;
  materialize: (
    grounding: RunGrounding,
    destination: RunRef
  ) => Promise<RunGroundingMaterializationResult>;
  profiles: {
    registerConnectionProfile(
      input: GroundingProfileRegistration,
      caller: GroundingCallerContext,
      reauthorize: GroundingProfileReauthorization
    ): GroundingProfile;
    revokeProfile(profileId: GroundingProfileId): void;
  };
  impactContexts: Pick<RunImpactContextRegistry, 'register' | 'unregister'>;
  trackEvent: typeof emitTelemetryEvent;
  now?: () => number;
}

function runRefKey(run: RunRef): string {
  return `${run.runType}:${run.runId}`;
}

function groundingProvider(provider: SkillProvider): RunGrounding['provider'] {
  return provider === 'ado' ? 'azure_devops' : 'github';
}

function profileProvider(provider: RunGrounding['provider']): SkillProvider {
  return provider === 'azure_devops' ? 'ado' : 'github';
}

function repositoryName(repository: CallerRepository): string {
  if (repository.provider !== 'github') return repository.repo;
  const name = repository.repo.split('/').pop();
  return name || repository.repo;
}

function activeTarget(groundings: RunGrounding[]): RunGrounding | undefined {
  return groundings.find(
    (grounding) => grounding.repoRole === 'target' && grounding.isActive
  );
}

function activatedTarget(
  activation: ActivateRunGroundingsResult
): RunGrounding | undefined {
  return activation.ok ? activeTarget(activation.groundings) : undefined;
}

function callerRunTitle(caller: string): string {
  const words = caller
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) =>
      word.toLowerCase() === 'apex' ? 'Apex' : word.toLowerCase()
    );
  if (words.length === 0) return 'Grounded run';
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(' ')} run`;
}

function isNativeReadCapabilityResult(
  value: unknown
): value is NativeReadCapabilityResult {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as { proven?: unknown; reason?: unknown };
  return (
    typeof candidate.proven === 'boolean' &&
    typeof candidate.reason === 'string' &&
    candidate.reason.length > 0 &&
    candidate.reason.length <= 64 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.reason)
  );
}

export function createCallerGroundingService(
  dependencies: CallerGroundingDependencies
): {
  start(input: StartCallerGroundingInput): Promise<CallerGroundingSelection>;
} {
  const telemetry = createGroundingTelemetry(dependencies.trackEvent);
  const now = dependencies.now ?? Date.now;
  const telemetryContext = (input: StartCallerGroundingInput) => ({
    caller: input.caller,
    project: input.run.project,
    runId: input.run.runId,
    runType: input.run.runType,
  });
  const remote = (): RemoteCallerGrounding => ({
    mode: 'remote',
    release: async () => undefined,
  });

  const fallback = (
    input: StartCallerGroundingInput,
    reason: string
  ): RemoteCallerGrounding => {
    const context = telemetryContext(input);
    telemetry.fallback(context, reason);
    return remote();
  };

  const startLocal = async (
    input: StartCallerGroundingInput,
    setMaterializationMode: (mode: 'cold' | 'warm') => void
  ): Promise<CallerGroundingSelection> => {
    try {
      const repo = repositoryName(input.repository);
      const existing = activeTarget(
        await dependencies.groundingService.getGroundings(input.run)
      );
      let grounding = existing;
      setMaterializationMode(existing ? 'warm' : 'cold');

      if (!grounding) {
        const cache = await dependencies.ensureRepoCache({
          provider: input.repository.provider,
          project: input.run.project,
          repo,
          branch: input.repository.branch,
        });
        if (cache.mirrorHit !== undefined) {
          telemetry.mirror(telemetryContext(input), cache.mirrorHit);
        }
        grounding = activatedTarget(
          await dependencies.groundingService.activateGroundings({
            run: input.run,
            target: {
              provider: groundingProvider(input.repository.provider),
              repository: repo,
              branch: input.repository.branch,
              groundedSha: cache.baseSha,
            },
          })
        );
      }

      if (!grounding || grounding.groundedSha.trim().length === 0) {
        return fallback(input, 'activation-unavailable');
      }

      // @feature-flag:shared-readonly-grounding-checkout start winner=enabled
      // Read-only chat callers share ONE per-SHA checkout instead of cloning a
      // fresh per-run working tree — removing the "preparing" pause when the
      // target branch has not advanced. Writers keep per-run isolation because
      // they never set `readOnlyShareable`.
      let workspacePath: string | undefined;
      let sharedIdentity: SharedReadCheckoutIdentity | undefined;
      if (input.readOnlyShareable) {
        let sharedEnabled = false;
        try {
          sharedEnabled = await dependencies.isSharedReadCheckoutEnabledForCaller({
            userId: input.userId,
            project: input.run.project,
            caller: input.caller,
          });
        } catch {
          sharedEnabled = false;
        }
        if (sharedEnabled) {
          // @feature-flag:shared-readonly-grounding-checkout enabled-start
          try {
            const identity: SharedReadCheckoutIdentity = {
              provider: profileProvider(grounding.provider),
              project: grounding.project,
              repo,
              branch: grounding.branch,
              sha: grounding.groundedSha,
            };
            const shared =
              await dependencies.sharedReadCheckout.materialize(identity);
            dependencies.sharedReadCheckout.retain(identity);
            sharedIdentity = identity;
            workspacePath = shared.workspacePath;
            if (shared.outcome === 'hit') setMaterializationMode('warm');
          } catch {
            // Any failure falls through to the per-run materialization path.
            sharedIdentity = undefined;
            workspacePath = undefined;
          }
          // @feature-flag:shared-readonly-grounding-checkout enabled-end
        }
      }
      // @feature-flag:shared-readonly-grounding-checkout end

      if (!workspacePath) {
        const materialized = await dependencies.materialize(grounding, input.run);
        if (
          materialized.state !== 'materialized' ||
          !materialized.workspacePath
        ) {
          return fallback(input, 'materialization-unavailable');
        }
        workspacePath = materialized.workspacePath;
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
          checkoutPath: workspacePath,
          caller: input.caller,
        },
        callerContext,
        input.reauthorize
      );
      dependencies.impactContexts.register(input.run, {
        authorId: input.userId,
        title: callerRunTitle(input.caller),
        link: '/home',
        caller: input.caller,
      });

      let released = false;
      return {
        mode: 'local',
        cwd: workspacePath,
        profileId: profile.id,
        resolvedSha: grounding.groundedSha,
        nativeReads: false,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await dependencies.groundingService.markTerminalInactive(input.run);
          } finally {
            dependencies.impactContexts.unregister(input.run);
            dependencies.profiles.revokeProfile(profile.id);
            // Drop our shared-checkout hold; eviction reclaims it by idle TTL.
            if (sharedIdentity) {
              dependencies.sharedReadCheckout.releaseRef(sharedIdentity);
            }
          }
        },
      };
    } catch {
      return fallback(input, 'startup-failed');
    }
  };

  return {
    async start(input) {
      let nativeReadEnabled = false;
      let nativeReadEvaluationFailed = false;
      try {
        nativeReadEnabled = await dependencies.isNativeReadEnabledForCaller(
          {
            userId: input.userId,
            project: input.run.project,
            caller: input.caller,
          },
          () => {
            nativeReadEvaluationFailed = true;
          }
        );
      } catch {
        nativeReadEvaluationFailed = true;
      }

      telemetry.nativeReadFlagEvaluated(
        telemetryContext(input),
        nativeReadEvaluationFailed
          ? 'error'
          : nativeReadEnabled
            ? 'enabled'
            : 'disabled',
        nativeReadEvaluationFailed
          ? 'evaluation-failed'
          : nativeReadEnabled
            ? 'targeted-rollout'
            : 'default-off'
      );

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
          }
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
      const startedAt = now();
      let materializationMode: 'cold' | 'warm' = 'cold';
      const local = await startLocal(input, (mode) => {
        materializationMode = mode;
      });
      telemetry.materialization(
        telemetryContext(input),
        materializationMode,
        now() - startedAt,
        local.mode === 'local' ? 'success' : 'failure'
      );
      if (local.mode === 'remote') {
        telemetry.failure(
          telemetryContext(input),
          'grounded-caller-attempt-failed'
        );
      }
      // @feature-flag:repo-grounding-workspace-profile enabled-end
      // @feature-flag:repo-grounding-workspace-profile end

      if (local.mode === 'remote') {
        return local;
      }

      let selected: LocalCallerGrounding;
      // Retain enabled after two stable sprints at full rollout.
      // @feature-flag:native-read start winner=enabled
      if (nativeReadEnabled && !nativeReadEvaluationFailed) {
        // @feature-flag:native-read enabled-start
        let nativeReads = false;
        try {
          const capability = dependencies.evaluateNativeReadCapability({
            usableShaPinnedCheckout: true,
            pathConfinementGuardsActive: true,
          });
          if (!isNativeReadCapabilityResult(capability)) {
            telemetry.nativeReadCapabilitySelfCheck(
              telemetryContext(input),
              'error',
              'malformed-result'
            );
            telemetry.fallback(
              telemetryContext(input),
              'native-read-capability-evaluation-failed'
            );
          } else {
            telemetry.nativeReadCapabilitySelfCheck(
              telemetryContext(input),
              capability.proven ? 'proven' : 'not-proven',
              capability.reason
            );
            if (capability.proven) {
              nativeReads = true;
              telemetry.nativeReadEngaged(telemetryContext(input));
            } else {
              telemetry.fallback(
                telemetryContext(input),
                'native-read-capability-unproven'
              );
            }
          }
        } catch {
          telemetry.nativeReadCapabilitySelfCheck(
            telemetryContext(input),
            'error',
            'evaluation-failed'
          );
          telemetry.fallback(
            telemetryContext(input),
            'native-read-capability-evaluation-failed'
          );
        }
        selected = { ...local, nativeReads };
        // @feature-flag:native-read enabled-end
      } else {
        // @feature-flag:native-read disabled-start
        telemetry.fallback(
          telemetryContext(input),
          nativeReadEvaluationFailed
            ? 'native-read-flag-evaluation-failed'
            : 'native-read-flag-off'
        );
        selected = local;
        // @feature-flag:native-read disabled-end
      }
      // @feature-flag:native-read end
      return selected;
    },
  };
}

export const callerGroundingService = createCallerGroundingService({
  isGroundingEnabledForCaller: evaluateGroundingFlag,
  isNativeReadEnabledForCaller: evaluateNativeReadFlag,
  isSharedReadCheckoutEnabledForCaller: evaluateSharedReadCheckoutFlag,
  evaluateNativeReadCapability: evaluateNativeReadCapabilityCheck,
  sharedReadCheckout: sharedReadCheckoutService,
  ensureRepoCache: ensureRepositoryCache,
  groundingService: runGroundingService,
  materialize: materializeRunGroundingWithPath,
  profiles: groundingProfileResolver,
  impactContexts: runImpactContextRegistry,
  trackEvent: emitTelemetryEvent,
});
