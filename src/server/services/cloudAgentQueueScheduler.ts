/**
 * Restarts the cloud-agent queue after a process start. Each sweep first
 * finishes container executions whose page is closed, then starts queued runs
 * in the slots that opened. Slot releases also pump the queue immediately.
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
