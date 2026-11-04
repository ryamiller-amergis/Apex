/**
 * Scheduler for 90-day cancelled-run integration branch cleanup (FEAT-015, TBI-028 / S10).
 */
import {
  createSingleFlight,
  stuckAfterForInterval,
} from '../../utils/singleFlight';
import { runBranchCleanupPass } from './buildBranchCleanup';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function createBuildBranchCleanupScheduler(options?: {
  runPass?: () => Promise<unknown>;
  intervalMs?: number;
}) {
  const runPass = options?.runPass ?? (() => runBranchCleanupPass());
  const intervalMs = options?.intervalMs ?? SIX_HOURS_MS;
  const guard = createSingleFlight({
    name: 'build-branch-cleanup',
    stuckAfterMs: stuckAfterForInterval(intervalMs),
  });

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void guard.run(runPass);
      }, intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runNow: () => guard.run(runPass),
  };
}
