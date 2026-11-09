import type { PreWarmTarget } from '../../shared/types/runGrounding';
import {
  onGroundingActiveSetChanged,
  type GroundingActiveSetChangeHandler,
} from './groundingMaintenanceEvents';
import {
  groundingEvictionService,
  type GroundingEvictionService,
} from './groundingEvictionService';
import {
  groundingPreWarmService,
  type GroundingPreWarmService,
} from './groundingPreWarmService';
import {
  groundingStalenessService,
  type GroundingStalenessService,
} from './groundingStalenessService';
import {
  sharedReadCheckoutService,
  type SharedReadCheckoutService,
} from './grounding/sharedReadCheckoutService';
import {
  nightlyIdleReGroundService,
  type NightlyIdleReGroundOptions,
  type NightlyIdleReGroundResult,
} from './nightlyIdleReGroundService';
import {
  repoCacheEvictionService,
  type RepoCacheEvictionService,
} from './repoCacheEvictionService';
import { withRepoCacheLease } from './repoCacheLeaseService';
import { isFlagEnabledForWholeProject } from './featureFlagService';
import {
  createSingleFlight,
  stuckAfterForInterval,
  type SingleFlight,
} from '../utils/singleFlight';

export const GROUNDING_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const CLAIM_EXPIRY_HEADROOM_MS = 5_000;

/**
 * `full` grounds repositories and cleans up after them. `cleanup-only` is for
 * the staging slot: it shares production's database, so a full sweep there
 * would clone production's active repositories onto staging's disk. A swap
 * still hands staging production's old disk, so staging keeps evicting and
 * compacting what it inherits.
 *
 * `legacy-projects` (App Service) grounds only projects that are not wholly on
 * `ai-runs-v2-transport`, because their mirrors live on App Service's own disk,
 * and leaves the shared workspace share to repo-read. `v2-projects`
 * (repo-read) grounds only projects wholly on V2 and cleans the shared
 * workspace share; it never compacts mirrors it is serving. `disk-only`
 * (staging, once repo-read owns the share) only compacts this host's own
 * repo cache.
 */
export type GroundingMaintenanceMode =
  | 'full'
  | 'cleanup-only'
  | 'disk-only'
  | 'legacy-projects'
  | 'v2-projects';

const GROUNDING_MAINTENANCE_MODES: readonly GroundingMaintenanceMode[] = [
  'full',
  'cleanup-only',
  'disk-only',
  'legacy-projects',
  'v2-projects',
];

const V2_TRANSPORT_FLAG = 'ai-runs-v2-transport';

export function resolveGroundingMaintenanceMode(
  raw: string | undefined,
): GroundingMaintenanceMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'full';
  const mode = GROUNDING_MAINTENANCE_MODES.find((candidate) => candidate === value);
  if (mode) return mode;
  console.warn(
    `[grounding-maintenance] unknown GROUNDING_MAINTENANCE_MODE="${raw}"; using full`,
  );
  return 'full';
}

/**
 * Each mode claims its own key. A cleanup-only instance holding the full key
 * would make production skip its pre-warm for that interval.
 */
export function groundingMaintenanceClaimKey(
  mode: GroundingMaintenanceMode,
): string {
  switch (mode) {
    case 'full':
      return 'grounding-maintenance:sweep';
    case 'cleanup-only':
      return 'grounding-maintenance:sweep:cleanup-only';
    case 'disk-only':
      return 'grounding-maintenance:sweep:disk-only';
    case 'legacy-projects':
      return 'grounding-maintenance:sweep:legacy-projects';
    case 'v2-projects':
      return 'grounding-maintenance:sweep:v2-projects';
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled grounding maintenance mode: ${String(unhandled)}`);
    }
  }
}

/** Whether the mode clones, refreshes, and re-grounds repositories. */
function groundsRepositories(mode: GroundingMaintenanceMode): boolean {
  switch (mode) {
    case 'full':
    case 'legacy-projects':
    case 'v2-projects':
      return true;
    case 'cleanup-only':
    case 'disk-only':
      return false;
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled grounding maintenance mode: ${String(unhandled)}`);
    }
  }
}

/** Whether the mode evicts workspaces and shared checkouts on the workspace share. */
function cleansWorkspaceShare(mode: GroundingMaintenanceMode): boolean {
  switch (mode) {
    case 'full':
    case 'cleanup-only':
    case 'v2-projects':
      return true;
    case 'disk-only':
    case 'legacy-projects':
      return false;
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled grounding maintenance mode: ${String(unhandled)}`);
    }
  }
}

/** Whether the mode evicts and compacts mirrors on this host's repo cache. */
function evictsRepoCache(mode: GroundingMaintenanceMode): boolean {
  switch (mode) {
    case 'full':
    case 'cleanup-only':
    case 'disk-only':
    case 'legacy-projects':
      return true;
    case 'v2-projects':
      return false;
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled grounding maintenance mode: ${String(unhandled)}`);
    }
  }
}

export type ProjectFilter = (project: string) => Promise<boolean>;

/**
 * Decides per project whether this host grounds it. An unreadable flag keeps
 * the project on App Service (`legacy-projects` includes it, `v2-projects`
 * skips it), so no project loses its upkeep.
 */
export function createProjectFilter(
  mode: GroundingMaintenanceMode,
  isV2Project: ProjectFilter,
): ProjectFilter | undefined {
  switch (mode) {
    case 'full':
    case 'cleanup-only':
    case 'disk-only':
      return undefined;
    case 'legacy-projects':
    case 'v2-projects': {
      const wantV2 = mode === 'v2-projects';
      const decisions = new Map<string, Promise<boolean>>();
      return (project) => {
        let decision = decisions.get(project);
        if (!decision) {
          decision = isV2Project(project).then(
            (onV2) => onV2 === wantV2,
            () => !wantV2,
          );
          decisions.set(project, decision);
        }
        return decision;
      };
    }
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled grounding maintenance mode: ${String(unhandled)}`);
    }
  }
}

function defaultIsV2Project(project: string): Promise<boolean> {
  return isFlagEnabledForWholeProject(V2_TRANSPORT_FLAG, project);
}

export interface GroundingMaintenanceSchedulerDependencies {
  preWarmService?: Pick<GroundingPreWarmService, 'preWarm' | 'sweep'>;
  evictionService?: Pick<GroundingEvictionService, 'evictIdle'>;
  sharedReadCheckoutService?: Pick<SharedReadCheckoutService, 'evictIdle'>;
  repoCacheEvictionService?: Pick<
    RepoCacheEvictionService,
    'evictOverBudget'
  >;
  stalenessService?: Pick<GroundingStalenessService, 'evaluateActive'>;
  nightlyIdleReGround?: {
    runIfDue: (options?: NightlyIdleReGroundOptions) => Promise<NightlyIdleReGroundResult>;
  };
  subscribe?: (
    handler: GroundingActiveSetChangeHandler,
  ) => () => void;
  runLeaderSweep?: (
    operation: () => Promise<void>,
    leaseWindowMs: number,
    claimKey: string,
  ) => Promise<void>;
  /** Whether a project is wholly on V2; defaults to the `ai-runs-v2-transport` flag. */
  isV2Project?: ProjectFilter;
  startupDelayMs?: number;
  intervalMs?: number;
  /** Raw setting value; defaults to `GROUNDING_MAINTENANCE_MODE`. */
  mode?: string;
}

export class GroundingMaintenanceScheduler {
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly runGuard: SingleFlight;
  private readonly preWarmService: Pick<
    GroundingPreWarmService,
    'preWarm' | 'sweep'
  >;
  private readonly evictionService: Pick<
    GroundingEvictionService,
    'evictIdle'
  >;
  private readonly sharedReadCheckoutService: Pick<
    SharedReadCheckoutService,
    'evictIdle'
  >;
  private readonly repoCacheEvictionService: Pick<
    RepoCacheEvictionService,
    'evictOverBudget'
  >;
  private readonly stalenessService: Pick<
    GroundingStalenessService,
    'evaluateActive'
  >;
  private readonly nightlyIdleReGround: {
    runIfDue: (options?: NightlyIdleReGroundOptions) => Promise<NightlyIdleReGroundResult>;
  };
  private readonly isV2Project: ProjectFilter;
  private readonly subscribe: (
    handler: GroundingActiveSetChangeHandler,
  ) => () => void;
  private readonly runLeaderSweep: (
    operation: () => Promise<void>,
    leaseWindowMs: number,
    claimKey: string,
  ) => Promise<void>;
  private readonly startupDelayMs: number;
  private readonly intervalMs: number;
  readonly mode: GroundingMaintenanceMode;

  constructor(
    dependencies: GroundingMaintenanceSchedulerDependencies = {},
  ) {
    this.mode = resolveGroundingMaintenanceMode(
      dependencies.mode ?? process.env.GROUNDING_MAINTENANCE_MODE,
    );
    this.preWarmService =
      dependencies.preWarmService ?? groundingPreWarmService;
    this.evictionService =
      dependencies.evictionService ?? groundingEvictionService;
    this.sharedReadCheckoutService =
      dependencies.sharedReadCheckoutService ?? sharedReadCheckoutService;
    this.repoCacheEvictionService =
      dependencies.repoCacheEvictionService ?? repoCacheEvictionService;
    this.stalenessService =
      dependencies.stalenessService ?? groundingStalenessService;
    this.nightlyIdleReGround =
      dependencies.nightlyIdleReGround ?? nightlyIdleReGroundService;
    this.isV2Project = dependencies.isV2Project ?? defaultIsV2Project;
    this.subscribe =
      dependencies.subscribe ?? onGroundingActiveSetChanged;
    this.runLeaderSweep =
      dependencies.runLeaderSweep ??
      ((operation, leaseWindowMs, claimKey) =>
        withRepoCacheLease(
          claimKey,
          async () => operation(),
          {
            leaseMs: leaseWindowMs,
            waitMs: 0,
            // Preserve the claim after work completes. Releasing here would
            // let every staggered instance run the same sweep sequentially.
            releaseOnComplete: false,
          },
        ));
    this.startupDelayMs =
      dependencies.startupDelayMs ?? 5_000 + Math.floor(Math.random() * 10_000);
    this.intervalMs =
      dependencies.intervalMs ?? GROUNDING_MAINTENANCE_INTERVAL_MS;
    this.runGuard = createSingleFlight({
      name: 'grounding-maintenance',
      stuckAfterMs: stuckAfterForInterval(this.intervalMs),
    });
  }

  start(): void {
    if (this.intervalTimer) return;
    const runScheduled = () => {
      void this.runNow().catch(() => {
        console.warn('[grounding-maintenance] scheduled sweep failed');
      });
    };
    this.startupTimer = setTimeout(runScheduled, this.startupDelayMs);
    this.startupTimer.unref?.();
    this.intervalTimer = setInterval(runScheduled, this.intervalMs);
    this.intervalTimer.unref?.();
    if (!groundsRepositories(this.mode)) {
      console.log(`[grounding-maintenance] mode=${this.mode}; pre-warm, staleness and nightly re-ground are off`);
      return;
    }
    this.unsubscribe = this.subscribe((target: PreWarmTarget) => {
      const includeProject = createProjectFilter(this.mode, this.isV2Project);
      void Promise.resolve(includeProject ? includeProject(target.project) : true)
        .then(async (included) => {
          if (!included) return;
          await this.preWarmService.preWarm(target);
          await this.stalenessService.evaluateActive(target);
        })
        .catch(() => {
          console.warn('[grounding-maintenance] event pre-warm failed');
        });
    });
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async runNow(): Promise<void> {
    const runToken = this.runGuard.tryEnter();
    if (runToken === null) return;
    try {
      const leaseWindowMs = Math.max(
        1_000,
        this.intervalMs - CLAIM_EXPIRY_HEADROOM_MS,
      );
      try {
        await this.runLeaderSweep(async () => {
          // Each step runs even if an earlier one failed: a pre-warm clone
          // that fails on a full disk must not skip the evictions that free it.
          const failedSteps: string[] = [];
          const runStep = async (name: string, step: () => Promise<unknown>) => {
            try {
              await step();
            } catch (error) {
              failedSteps.push(name);
              console.warn(
                `[grounding-maintenance] step=${name} failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          };
          const grounds = groundsRepositories(this.mode);
          const includeProject = createProjectFilter(this.mode, this.isV2Project);
          if (grounds) {
            await runStep('pre-warm', () => this.preWarmService.sweep({ includeProject }));
            await runStep('staleness', () =>
              this.stalenessService.evaluateActive(undefined, { includeProject }));
          }
          if (cleansWorkspaceShare(this.mode)) {
            await runStep('workspace-eviction', () => this.evictionService.evictIdle());
            await runStep('shared-checkout-eviction', () => this.sharedReadCheckoutService.evictIdle());
          }
          // Runs after the workspace sweeps so freed checkouts count against
          // the share before mirrors are considered for deletion. Also
          // compacts oversized mirrors.
          if (evictsRepoCache(this.mode)) {
            await runStep('repo-cache-eviction', () => this.repoCacheEvictionService.evictOverBudget());
          }
          if (grounds) {
            // V2 chat hosts check out by commit themselves, so repo-read only re-pins.
            await runStep('nightly-re-ground', () =>
              this.nightlyIdleReGround.runIfDue({
                includeProject,
                materialize: this.mode !== 'v2-projects',
              }));
          }
          if (failedSteps.length > 0) {
            throw new Error(`Grounding maintenance steps failed: ${failedSteps.join(', ')}`);
          }
        }, leaseWindowMs, groundingMaintenanceClaimKey(this.mode));
      } catch (error) {
        if (
          error instanceof Error
          && error.message.startsWith(
            'Timed out waiting for repository cache lease:',
          )
        ) {
          return;
        }
        throw error;
      }
    } finally {
      this.runGuard.exit(runToken);
    }
  }
}

export function createGroundingMaintenanceScheduler(
  dependencies: GroundingMaintenanceSchedulerDependencies = {},
): GroundingMaintenanceScheduler {
  return new GroundingMaintenanceScheduler(dependencies);
}

export const groundingMaintenanceScheduler =
  createGroundingMaintenanceScheduler();
