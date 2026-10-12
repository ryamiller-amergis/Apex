/**
 * After a process start, finishes cloud-agent runs that have already ended,
 * then sends any saved runs that never reached Cursor. A start calls the SDK
 * in the request that created it; this sweep only recovers leftovers.
 */
import { pumpCloudAgentQueue, reconcileRunningCloudAgentRuns } from './cloudAgentService';

const SWEEP_MS = 10_000;

let timer: ReturnType<typeof setInterval> | null = null;

async function sweepCloudAgentQueue(): Promise<void> {
  await reconcileRunningCloudAgentRuns();
  await pumpCloudAgentQueue();
}

export function startCloudAgentQueueScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweepCloudAgentQueue();
  }, SWEEP_MS);
  timer.unref?.();
  void sweepCloudAgentQueue();
}

export function stopCloudAgentQueueScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
