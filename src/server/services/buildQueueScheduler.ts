import { isBuildFromPromptOperational } from './buildAccessService';
import { promoteDueBuilds } from './buildOrchestrator/promote';

export const BUILD_QUEUE_INTERVAL_MS = 10_000;

let timer: ReturnType<typeof setInterval> | null = null;

export async function runBuildQueueSweep(
  deps: {
    isOperational: () => Promise<boolean>;
    promote: () => Promise<unknown>;
  } = {
    isOperational: isBuildFromPromptOperational,
    promote: promoteDueBuilds,
  },
): Promise<void> {
  if (!(await deps.isOperational())) return;
  await deps.promote();
}

export function startBuildQueueScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void runBuildQueueSweep().catch((error: unknown) => {
      console.error('[build-queue] sweep failed:', error instanceof Error ? error.name : 'Error');
    });
  }, BUILD_QUEUE_INTERVAL_MS);
  timer.unref?.();
}

export function stopBuildQueueScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
