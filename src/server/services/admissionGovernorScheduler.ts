/**
 * Per-instance safety sweep for FEAT-002 background admission.
 *
 * Each instance selects downward jitter from the mandated 30-second ceiling.
 * The database governor remains authoritative across instances, while the
 * in-process running guard prevents this instance from overlapping its sweep.
 */
import {
  recoverStaleDispatchedRuns,
  runAdmissionCycle,
  type AdmissionReason,
} from './admissionGovernorService';

const MAX_SWEEP_DELAY_MS = 30_000;
const DOWNWARD_JITTER_MS = 6_000;

type SchedulerDependencies = {
  recoverStaleDispatchedRuns?: () => Promise<unknown>;
  runAdmissionCycle?: (reason: AdmissionReason) => Promise<unknown>;
  random?: () => number;
  logError?: (message: string, fields: Record<string, string>) => void;
};

export type AdmissionGovernorScheduler = {
  start(): void;
  stop(): void;
  /** Public cycle seam for deterministic tests and operational invocation. */
  runNow(): Promise<boolean>;
};

/**
 * Resolve one per-cycle downward-jittered delay in the inclusive 24-30s range.
 */
export function computeAdmissionSweepDelayMs(
  random: () => number = Math.random,
): number {
  const sample = random();
  const normalized = Number.isFinite(sample)
    ? Math.min(1, Math.max(0, sample))
    : 0;
  return MAX_SWEEP_DELAY_MS - Math.floor(normalized * DOWNWARD_JITTER_MS);
}

export function createAdmissionGovernorScheduler(
  dependencies: SchedulerDependencies = {},
): AdmissionGovernorScheduler {
  const recover =
    dependencies.recoverStaleDispatchedRuns ?? recoverStaleDispatchedRuns;
  const admit = dependencies.runAdmissionCycle ?? runAdmissionCycle;
  const random = dependencies.random ?? Math.random;
  const logError = dependencies.logError
    ?? ((message: string, fields: Record<string, string>) => {
      console.error(message, JSON.stringify(fields));
    });

  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let running = false;

  const safeLog = (
    message: string,
    fields: Record<string, string>,
  ): void => {
    try {
      logError(message, fields);
    } catch {
      // Observability must never stop admission recovery.
    }
  };

  const runNow = async (): Promise<boolean> => {
    if (running) return false;
    running = true;
    try {
      try {
        await recover();
      } catch {
        safeLog('[agent-run-admission] stale recovery sweep failed', {
          lane: 'background',
          reason: 'sweep',
          status: 'recovery_failed',
        });
      }

      try {
        await admit('sweep');
      } catch {
        safeLog('[agent-run-admission] safety admission sweep failed', {
          lane: 'background',
          reason: 'sweep',
          status: 'admission_failed',
        });
      }
      return true;
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (!started || timer) return;
    timer = setInterval(() => {
      void runNow();
    }, computeAdmissionSweepDelayMs(random));
    timer.unref?.();
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      schedule();
    },

    stop(): void {
      started = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    runNow,
  };
}

const defaultAdmissionGovernorScheduler =
  createAdmissionGovernorScheduler();

export function startAdmissionGovernorScheduler(): void {
  defaultAdmissionGovernorScheduler.start();
}

export function stopAdmissionGovernorScheduler(): void {
  defaultAdmissionGovernorScheduler.stop();
}
