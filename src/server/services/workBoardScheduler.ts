/**
 * Work Board Scheduler
 *
 * Periodic job that notifies owners of work items due within 2 days.
 * Started from server boot (index.ts). Also available via
 * POST /api/apex-work-items/jobs/due-soon (work-board:admin) and the
 * opportunistic hook in listApexWorkItems.
 */
import { notifyDueSoonWorkItems } from './apexWorkItemService';

export class WorkBoardSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private initialTimeoutId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

  start(): void {
    if (this.intervalId) {
      console.log('[WorkBoardScheduler] Service already running');
      return;
    }

    console.log('[WorkBoardScheduler] Starting service — checking every hour');
    this.initialTimeoutId = setTimeout(() => {
      this.initialTimeoutId = null;
      this.run();
    }, 3 * 60 * 1000);
    this.intervalId = setInterval(() => this.run(), this.CHECK_INTERVAL);
  }

  stop(): void {
    if (this.initialTimeoutId) {
      clearTimeout(this.initialTimeoutId);
      this.initialTimeoutId = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[WorkBoardScheduler] Service stopped');
    }
  }

  private async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const count = await notifyDueSoonWorkItems();
      if (count > 0) {
        console.log(`[WorkBoardScheduler] Sent ${count} due-soon notification(s)`);
      }
    } catch (err) {
      console.error('[WorkBoardScheduler] Error during run:', (err as Error).message);
    } finally {
      this.isRunning = false;
    }
  }
}

export const workBoardScheduler = new WorkBoardSchedulerService();

export function startWorkBoardScheduler(): void {
  workBoardScheduler.start();
}
