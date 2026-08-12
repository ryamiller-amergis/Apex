/**
 * AI Cost Scheduler
 *
 * Hourly background job that:
 *  1. Syncs authoritative Cursor billing events from the Admin API
 *  2. Syncs Apex-scoped Bedrock billed totals from AWS Cost Explorer
 *  3. Runs cost allocation for Cursor and Bedrock onto ai_usage_events
 *  4. Generates daily AI cost briefs at 8am (morning) and 2pm (afternoon)
 *
 * Mirrors the StandupSchedulerService singleton pattern.
 */
import { runCursorBillingSync } from './cursorBillingSyncService';
import { runCostAllocation } from './aiCostAllocationService';
import { runBedrockBillingSync } from './bedrockBillingSyncService';
import { runBedrockCostAllocation } from './bedrockCostAllocationService';
import { generateBriefForAllProjects } from './aiCostDailyBriefService';

export class AiCostSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastBriefRun: Date | null = null;
  private readonly CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

  start(): void {
    if (this.intervalId) {
      console.log('[AiCostScheduler] Service already running');
      return;
    }

    console.log('[AiCostScheduler] Starting service — checking every hour');

    // Stagger initial run by 2 minutes to avoid startup congestion
    setTimeout(() => this.run(), 2 * 60 * 1000);
    this.intervalId = setInterval(() => this.run(), this.CHECK_INTERVAL);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[AiCostScheduler] Service stopped');
    }
  }

  private async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const cursor = await runCursorBillingSync();
      if (!cursor.ok && !cursor.skipped) {
        console.error('[AiCostScheduler] Cursor sync failed:', cursor.error);
      }

      const bedrock = await runBedrockBillingSync();
      if (!bedrock.ok && !bedrock.skipped) {
        console.error('[AiCostScheduler] Bedrock sync failed:', bedrock.error);
      }

      try {
        await runCostAllocation();
        await runBedrockCostAllocation();
      } catch (err) {
        console.error('[AiCostScheduler] Allocation failed:', (err as Error).message);
      }

      // Briefs at 8am (morning — yesterday's recap) and 2pm (afternoon — today so far)
      const now = new Date();
      const hour = now.getHours();
      const isMorning = hour === 8;
      const isAfternoon = hour === 14;

      if (isMorning && (!this.lastBriefRun || now.getDate() !== this.lastBriefRun.getDate())) {
        try {
          await generateBriefForAllProjects('morning');
          this.lastBriefRun = now;
          console.log('[AiCostScheduler] Morning brief generated (8am)');
        } catch (err) {
          console.error('[AiCostScheduler] Morning brief failed:', (err as Error).message);
        }
      }

      if (isAfternoon) {
        try {
          await generateBriefForAllProjects('afternoon');
          console.log('[AiCostScheduler] Afternoon brief generated (2pm)');
        } catch (err) {
          console.error('[AiCostScheduler] Afternoon brief failed:', (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[AiCostScheduler] Error during run:', (err as Error).message);
    } finally {
      this.isRunning = false;
    }
  }

}

export const aiCostScheduler = new AiCostSchedulerService();
