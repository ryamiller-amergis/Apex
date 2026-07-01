import { generateDailySessions, runFacilitator, sendStandupReminders } from './standupService';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { standupSessions } from '../db/schema';

/**
 * Background service that checks for due standup sessions and triggers
 * the facilitator for sessions past their deadline.
 * Mirrors the FeatureAutoCompleteService singleton pattern.
 */
export class StandupSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private readonly CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

  start(): void {
    if (this.intervalId) {
      console.log('[StandupScheduler] Service already running');
      return;
    }

    console.log('[StandupScheduler] Starting service — checking every 5 minutes');

    this.run();
    this.intervalId = setInterval(() => this.run(), this.CHECK_INTERVAL);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[StandupScheduler] Service stopped');
    }
  }

  private async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // 1. Generate any due sessions
      const created = await generateDailySessions();
      if (created > 0) {
        console.log(`[StandupScheduler] Created ${created} new session(s)`);
      }

      // 2. Send reminders for collecting sessions
      await this.sendReminders();

      // 3. Check for sessions past deadline that haven't been facilitated
      await this.checkDeadlines();
    } catch (err) {
      console.error('[StandupScheduler] Error during run:', (err as Error).message);
    } finally {
      this.isRunning = false;
    }
  }

  private async sendReminders(): Promise<void> {
    const collectingSessions = await db
      .select({ id: standupSessions.id })
      .from(standupSessions)
      .where(eq(standupSessions.status, 'collecting'));

    for (const session of collectingSessions) {
      try {
        await sendStandupReminders(session.id);
      } catch (err) {
        console.error(`[StandupScheduler] sendReminders failed for ${session.id}:`, (err as Error).message);
      }
    }
  }

  private async checkDeadlines(): Promise<void> {
    const collectingSessions = await db.query.standupSessions.findMany({
      where: eq(standupSessions.status, 'collecting'),
      with: { config: true },
    });

    const now = Date.now();

    for (const session of collectingSessions) {
      const createdAt = new Date(session.createdAt).getTime();
      const deadlineMin = session.config?.facilitatorDeadlineMin ?? 120;
      const deadlineMs = createdAt + deadlineMin * 60 * 1000;

      if (now > deadlineMs) {
        console.log(`[StandupScheduler] Session ${session.id} past deadline, triggering facilitator`);
        await runFacilitator(session.id).catch((err) =>
          console.error(`[StandupScheduler] facilitator failed for ${session.id}:`, (err as Error).message),
        );
      }
    }
  }
}

export const standupScheduler = new StandupSchedulerService();
