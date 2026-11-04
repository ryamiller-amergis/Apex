/**
 * 6-hour scheduler for the 90-day build retention pass (FEAT-016, TBI-030 / S10).
 */
import { createSingleFlight, stuckAfterForInterval } from '../utils/singleFlight';
import { runBuildRetentionPass } from './buildRetentionService';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export function createBuildRetentionScheduler(options?: {
  runPass?: () => Promise<unknown>;
  intervalMs?: number;
}) {
  const runPass = options?.runPass ?? (() => runBuildRetentionPass());
  const intervalMs = options?.intervalMs ?? SIX_HOURS_MS;
  const guard = createSingleFlight({
    name: 'build-retention',
    stuckAfterMs: stuckAfterForInterval(intervalMs),
  });

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      if (process.env.BUILD_RETENTION_DISABLED === 'true') return;
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
