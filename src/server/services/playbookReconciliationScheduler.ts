/**
 * The tick that drives the reconciliation sweep.
 *
 * Shaped after `admissionGovernorScheduler.ts`: a factory holding the timer and an in-process
 * running guard, with a `runNow` seam so tests drive a pass directly rather than waiting for a
 * clock. Keeping the timer out of the service is what makes the sweep testable at all.
 *
 * Sixty seconds rather than the governor's 24–30, because this is the correctness path and not the
 * latency path. Terminal agent-run events are what deliver low latency; PBI-005's performance
 * requirement asks only that an overdue suspension be expired "within one sweep interval".
 *
 * Jittered downward per instance so that a rolling deployment does not leave every instance ticking
 * in lockstep. They would not corrupt anything if they did — the advisory lock serialises them —
 * but they would all queue on that lock at the same moment, every minute, forever.
 */
import { getAppEnvironment } from '../utils/superAdmin';
import { isFeatureOperational } from './featureFlagService';
import {
  runReconciliationPassLocked,
  type Clock,
} from './playbookReconciliationService';
import {
  startPlaybookTerminalEventListener,
  stopPlaybookTerminalEventListener,
} from './playbookTerminalEventService';

const PLAYBOOKS_SPIKE_FLAG = 'playbooks-spike';

const MAX_SWEEP_DELAY_MS = 60_000;
const DOWNWARD_JITTER_MS = 12_000;

type SchedulerDependencies = {
  runPass?: (options: { clock?: Clock }) => Promise<unknown>;
  random?: () => number;
  logError?: (message: string, detail: string) => void;
};

export type PlaybookReconciliationScheduler = {
  start(): void;
  stop(): void;
  /** Cycle seam for deterministic tests and operational invocation. */
  runNow(): Promise<boolean>;
};

/** One per-cycle downward-jittered delay, in the inclusive 48–60s range. */
export function computeReconciliationDelayMs(random: () => number = Math.random): number {
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  return MAX_SWEEP_DELAY_MS - Math.floor(normalized * DOWNWARD_JITTER_MS);
}

export function createPlaybookReconciliationScheduler(
  dependencies: SchedulerDependencies = {}
): PlaybookReconciliationScheduler {
  const runPass = dependencies.runPass ?? runReconciliationPassLocked;
  const random = dependencies.random ?? Math.random;
  const logError =
    dependencies.logError ??
    ((message: string, detail: string) => console.error(message, detail));

  let timer: ReturnType<typeof setInterval> | null = null;
  let started = false;
  let running = false;

  /**
   * The in-process guard, separate from the advisory lock and not redundant with it.
   *
   * The lock stops two *instances* colliding. This stops one instance starting a second pass while
   * its first is still going, which is what happens when a pass takes longer than the interval —
   * without it, a slow pass compounds into a queue of passes all waiting on the same lock.
   */
  const runNow = async (): Promise<boolean> => {
    if (running) return false;
    running = true;
    try {
      await runPass({});
      return true;
    } catch (error) {
      // A failed pass must not stop the scheduler; the next tick is a minute away.
      logError(
        '[playbook-reconciliation] sweep failed',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      timer = setInterval(() => {
        void runNow();
      }, computeReconciliationDelayMs(random));
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
  };
}

const defaultScheduler = createPlaybookReconciliationScheduler();

/**
 * Starts the sweep and the terminal-event listener, if Playbooks are switched on at all.
 *
 * `isFeatureOperational` rather than `isFeatureEnabled` because startup has no user and no project
 * to evaluate targeting rules against — the question here is only whether the flag is on anywhere.
 * With it off, neither the timer nor the subscription is created: no run can exist to sweep, so a
 * sweep would be a query returning nothing, once a minute, forever.
 */
export async function startPlaybookReconciliation(): Promise<void> {
  let operational = false;
  try {
    operational = await isFeatureOperational(PLAYBOOKS_SPIKE_FLAG);
  } catch (error) {
    // An unreadable flag at boot is not a reason to fail boot. Playbooks stay dark; the sweep has
    // nothing to reconcile if no run can be started either.
    logStartupProblem(error);
    return;
  }

  // @feature-flag:playbooks-spike start winner=enabled
  if (!operational) {
    // @feature-flag:playbooks-spike disabled-start
    return;
    // @feature-flag:playbooks-spike disabled-end
  }
  // @feature-flag:playbooks-spike enabled-start
  startPlaybookTerminalEventListener();
  defaultScheduler.start();
  console.log(
    `[playbook-reconciliation] sweep started (${getAppEnvironment()}); terminal-event listener registered`
  );
  // @feature-flag:playbooks-spike enabled-end
  // @feature-flag:playbooks-spike end
}

function logStartupProblem(error: unknown): void {
  console.error(
    '[playbook-reconciliation] could not read the playbooks-spike flag; sweep not started:',
    error instanceof Error ? error.message : String(error)
  );
}

export function stopPlaybookReconciliation(): void {
  defaultScheduler.stop();
  stopPlaybookTerminalEventListener();
}
