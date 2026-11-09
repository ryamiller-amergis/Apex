/**
 * Daily verification of Playbook step-output objects.
 *
 * The sweep is deliberately infrequent. It lists one private container, checks retained references,
 * and deletes only objects that no step row names and that are older than the upload grace period.
 * A missed day leaves storage unchanged; it does not affect a running Playbook.
 */
import { reconcilePlaybookStepOutputs } from './playbookStepOutputCleanupService';

export const PLAYBOOK_OUTPUT_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CleanupSchedulerDependencies = {
  reconcile?: typeof reconcilePlaybookStepOutputs;
  logError?: (message: string, detail: string) => void;
};

export type PlaybookStepOutputCleanupScheduler = {
  start(): void;
  stop(): void;
  runNow(): Promise<boolean>;
};

export function createPlaybookStepOutputCleanupScheduler(
  dependencies: CleanupSchedulerDependencies = {}
): PlaybookStepOutputCleanupScheduler {
  const reconcile = dependencies.reconcile ?? reconcilePlaybookStepOutputs;
  const logError =
    dependencies.logError ??
    ((message: string, detail: string) => console.error(message, detail));
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const runNow = async (): Promise<boolean> => {
    if (running) return false;
    running = true;
    try {
      await reconcile();
      return true;
    } catch (error) {
      logError(
        '[playbook-step-output] cleanup failed',
        error instanceof Error ? error.message : String(error)
      );
      return false;
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void runNow();
      }, PLAYBOOK_OUTPUT_CLEANUP_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    runNow,
  };
}

const defaultScheduler = createPlaybookStepOutputCleanupScheduler();

export function startPlaybookStepOutputCleanup(): void {
  defaultScheduler.start();
  console.log('[playbook-step-output] daily cleanup scheduled');
}

export function stopPlaybookStepOutputCleanup(): void {
  defaultScheduler.stop();
}
