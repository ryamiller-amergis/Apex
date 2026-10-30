/**
 * The tick that drives the build sweep. Shaped after `playbookReconciliationScheduler.ts`.
 *
 * Twenty seconds at most, jittered down by up to four, because the flag-off
 * cancel and the missed-completion fallback must both land within 60 seconds.
 * One pass runs at start so a restart picks up half-finished builds at once.
 */
import { reconcileBuildRuns } from './buildOrchestrator';
import type { BuildSweepOutcome } from './buildOrchestrator/reconcile';
import { createSingleFlight, stuckAfterForInterval } from '../utils/singleFlight';

const MAX_SWEEP_DELAY_MS = 20_000;
const DOWNWARD_JITTER_MS = 4_000;

type SchedulerDependencies = {
  runPass?: () => Promise<BuildSweepOutcome>;
  random?: () => number;
  logError?: (message: string, detail: string) => void;
};

export type BuildReconciliationScheduler = {
  start(): void;
  stop(): void;
  /** Cycle seam for deterministic tests and operational invocation. */
  runNow(): Promise<boolean>;
  /** A stopped sweep and an idle sweep both report zero counts; only `startedAt` tells them apart. */
  lastOutcome(): BuildSweepOutcome | null;
};

/** One per-cycle downward-jittered delay, in the inclusive 16–20s range. */
export function computeBuildSweepDelayMs(random: () => number = Math.random): number {
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return MAX_SWEEP_DELAY_MS - Math.floor(normalized * DOWNWARD_JITTER_MS);
}

export function createBuildReconciliationScheduler(
  dependencies: SchedulerDependencies = {},
): BuildReconciliationScheduler {
  const runPass = dependencies.runPass ?? reconcileBuildRuns;
  const random = dependencies.random ?? Math.random;
  const logError = dependencies.logError
    ?? ((message: string, detail: string) => console.error(message, detail));

  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let last: BuildSweepOutcome | null = null;
  const runGuard = createSingleFlight({
    name: 'build-reconciliation',
    stuckAfterMs: stuckAfterForInterval(MAX_SWEEP_DELAY_MS),
  });

  const runNow = async (): Promise<boolean> => {
    const runToken = runGuard.tryEnter();
    if (runToken === null) return false;
    try {
      last = await runPass();
      return true;
    } catch (error) {
      logError('[build-reconciliation] sweep failed', error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      runGuard.exit(runToken);
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      void runNow();
      timer = setInterval(() => {
        void runNow();
      }, computeBuildSweepDelayMs(random));
      timer.unref?.();
    },

    stop(): void {
      started = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    runNow,
    lastOutcome: () => last,
  };
}

const defaultScheduler = createBuildReconciliationScheduler();

export function startBuildReconciliation(): void {
  defaultScheduler.start();
}

export function stopBuildReconciliation(): void {
  defaultScheduler.stop();
}

export function getLastBuildSweepOutcome(): BuildSweepOutcome | null {
  return defaultScheduler.lastOutcome();
}
