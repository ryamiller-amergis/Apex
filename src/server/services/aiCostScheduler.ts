/**
 * AI Cost Scheduler
 *
 * Hourly background job that:
 *  1. Syncs authoritative Cursor billing events from the Admin API
 *  2. Runs cost allocation to distribute Cursor chargedCents to ai_usage_events
 *  3. Generates daily AI cost briefs at 8am (morning) and 2pm (afternoon)
 *
 * Mirrors the StandupSchedulerService singleton pattern.
 */
import { runCursorBillingSync } from './cursorBillingSyncService';
import { runCostAllocation } from './aiCostAllocationService';
import { generateBriefForAllProjects } from './aiCostDailyBriefService';
import { aiCostUndercountReportService } from './aiCostUndercountReportService';
import { isFeatureOperational } from './featureFlagService';

export class AiCostSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastBriefRun: Date | null = null;
  private lastUndercountReportDate: string | null = null;
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
      // Step 1: Sync Cursor billing events
      if (process.env.CURSOR_TEAM_API_KEY) {
        await runCursorBillingSync();
      }

      // Step 2: Allocate costs
      await runCostAllocation();

      // Step 3: Generate briefs at 8am (morning — yesterday's recap) and 2pm (afternoon — today so far)
      const now = new Date();
      const hour = now.getHours();
      const isMorning = hour === 8;
      const isAfternoon = hour === 14;

      const productionAdaptersEnabled = await isFeatureOperational('playbooks-production-adapters');
      // @feature-flag:playbooks-production-adapters start winner=enabled
      if (productionAdaptersEnabled) {
        // @feature-flag:playbooks-production-adapters enabled-start
        const utcDate = now.toISOString().slice(0, 10);
        if (this.lastUndercountReportDate !== utcDate) {
          try {
            await aiCostUndercountReportService.run();
            this.lastUndercountReportDate = utcDate;
          } catch (err) {
            console.error(
              '[AiCostScheduler] Playbook spend undercount report failed:',
              (err as Error).message,
            );
          }
        }
        // @feature-flag:playbooks-production-adapters enabled-end
      } else {
        // @feature-flag:playbooks-production-adapters disabled-start
        // Preserve the existing scheduler: no Playbook spend report reads or writes.
        // @feature-flag:playbooks-production-adapters disabled-end
      }
      // @feature-flag:playbooks-production-adapters end

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
