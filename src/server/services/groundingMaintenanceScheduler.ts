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
  type NightlyIdleReGroundResult,
} from './nightlyIdleReGroundService';
import {
  repoCacheEvictionService,
  type RepoCacheEvictionService,
} from './repoCacheEvictionService';
import { withRepoCacheLease } from './repoCacheLeaseService';

export const GROUNDING_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
const GROUNDING_MAINTENANCE_CLAIM_KEY = 'grounding-maintenance:sweep';
const CLAIM_EXPIRY_HEADROOM_MS = 5_000;

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
    runIfDue: () => Promise<NightlyIdleReGroundResult>;
  };
  subscribe?: (
    handler: GroundingActiveSetChangeHandler,
  ) => () => void;
  runLeaderSweep?: (
    operation: () => Promise<void>,
    leaseWindowMs: number,
  ) => Promise<void>;
  startupDelayMs?: number;
  intervalMs?: number;
}

export class GroundingMaintenanceScheduler {
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private isRunning = false;
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
    runIfDue: () => Promise<NightlyIdleReGroundResult>;
  };
  private readonly subscribe: (
    handler: GroundingActiveSetChangeHandler,
  ) => () => void;
  private readonly runLeaderSweep: (
    operation: () => Promise<void>,
    leaseWindowMs: number,
  ) => Promise<void>;
  private readonly startupDelayMs: number;
  private readonly intervalMs: number;

  constructor(
    dependencies: GroundingMaintenanceSchedulerDependencies = {},
  ) {
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
    this.subscribe =
      dependencies.subscribe ?? onGroundingActiveSetChanged;
    this.runLeaderSweep =
      dependencies.runLeaderSweep ??
      ((operation, leaseWindowMs) =>
        withRepoCacheLease(
          GROUNDING_MAINTENANCE_CLAIM_KEY,
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
    this.unsubscribe = this.subscribe((target: PreWarmTarget) => {
      void this.preWarmService
        .preWarm(target)
        .then(() => this.stalenessService.evaluateActive(target))
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
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const leaseWindowMs = Math.max(
        1_000,
        this.intervalMs - CLAIM_EXPIRY_HEADROOM_MS,
      );
      try {
        await this.runLeaderSweep(async () => {
          await this.preWarmService.sweep();
          await this.stalenessService.evaluateActive();
          await this.evictionService.evictIdle();
          await this.sharedReadCheckoutService.evictIdle();
          // Runs after the workspace sweeps so freed checkouts count against
          // the share before mirrors are considered for deletion.
          await this.repoCacheEvictionService.evictOverBudget();
          await this.nightlyIdleReGround.runIfDue();
        }, leaseWindowMs);
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
      this.isRunning = false;
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
