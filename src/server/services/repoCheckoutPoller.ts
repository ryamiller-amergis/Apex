/**
 * Local/dev in-process poller for repository checkout jobs.
 * Azure uses the Container Apps Job; this path is opt-in via
 * REPO_CHECKOUT_WORKER_MODE=in-process and never runs git on App Service HTTP.
 */
import {
  processNextCheckoutJob,
} from './projectRepositoryCheckoutService';
import {
  isRepoCheckoutWorkerInProcess,
  recoverExpiredCheckoutJobs,
} from './repositoryCheckoutJobService';
import { getRepoCheckoutWakeupPublisher } from './repoCheckoutWakeupPublisher';

const POLL_MS = 2_000;
const REAPER_MS = 30_000;

let pollerTimer: NodeJS.Timeout | null = null;
let reaperTimer: NodeJS.Timeout | null = null;
let processing = false;

async function pollOnce(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    await processNextCheckoutJob();
  } catch (error) {
    console.error(
      '[repo-checkout] in-process poller failed',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    processing = false;
  }
}

async function reapOnce(): Promise<void> {
  try {
    const recovered = await recoverExpiredCheckoutJobs();
    if (recovered.length === 0 || isRepoCheckoutWorkerInProcess()) return;
    const publisher = getRepoCheckoutWakeupPublisher();
    for (const job of recovered) {
      await publisher.publish(job.id).catch((error: unknown) => {
        console.error(
          '[repo-checkout] requeue wakeup failed',
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  } catch (error) {
    console.error(
      '[repo-checkout] lease reaper failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function startRepoCheckoutPoller(): void {
  if (pollerTimer || reaperTimer) return;

  reaperTimer = setInterval(() => {
    void reapOnce();
  }, REAPER_MS);
  if (typeof reaperTimer.unref === 'function') reaperTimer.unref();

  if (!isRepoCheckoutWorkerInProcess()) {
    console.info('[repo-checkout] lease reaper started (execute stays off HTTP)');
    return;
  }

  pollerTimer = setInterval(() => {
    void pollOnce();
  }, POLL_MS);
  if (typeof pollerTimer.unref === 'function') pollerTimer.unref();
  console.info('[repo-checkout] in-process poller started');
  void pollOnce();
}

export function stopRepoCheckoutPoller(): void {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
