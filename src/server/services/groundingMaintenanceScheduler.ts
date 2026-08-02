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

export const GROUNDING_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export interface GroundingMaintenanceSchedulerDependencies {
  preWarmService?: Pick<GroundingPreWarmService, 'preWarm' | 'sweep'>;
  evictionService?: Pick<GroundingEvictionService, 'evictIdle'>;
  stalenessService?: Pick<GroundingStalenessService, 'evaluateActive'>;
  subscribe?: (
    handler: GroundingActiveSetChangeHandler,
  ) => () => void;
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
  private readonly stalenessService: Pick<
    GroundingStalenessService,
    'evaluateActive'
  >;
  private readonly subscribe: (
    handler: GroundingActiveSetChangeHandler,
  ) => () => void;
  private readonly startupDelayMs: number;
  private readonly intervalMs: number;

  constructor(
    dependencies: GroundingMaintenanceSchedulerDependencies = {},
  ) {
    this.preWarmService =
      dependencies.preWarmService ?? groundingPreWarmService;
    this.evictionService =
      dependencies.evictionService ?? groundingEvictionService;
    this.stalenessService =
      dependencies.stalenessService ?? groundingStalenessService;
    this.subscribe =
      dependencies.subscribe ?? onGroundingActiveSetChanged;
    this.startupDelayMs =
      dependencies.startupDelayMs ?? 30_000 + Math.floor(Math.random() * 60_000);
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
      await this.preWarmService.sweep();
      await this.stalenessService.evaluateActive();
      await this.evictionService.evictIdle();
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
