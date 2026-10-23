/**
 * Starts project background jobs whose daily UTC minute has arrived.
 * The sweep is the clock. Starting a job still uses the Cloud Agent launch.
 */
import { sweepDueCloudBackgroundJobs } from './cloudBackgroundJobService';

const CHECK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function sweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sweepDueCloudBackgroundJobs();
  } catch (err) {
    console.error(
      '[cloud-background-job] sweep failed',
      err instanceof Error ? err.message : err,
    );
  } finally {
    running = false;
  }
}

export function startCloudBackgroundJobScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweep();
  }, CHECK_MS);
  timer.unref?.();
  void sweep();
}

export function stopCloudBackgroundJobScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
