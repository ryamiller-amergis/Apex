/**
 * Daily scan for API keys approaching expiry (30 / 7 / 1 day reminders).
 */
import { runApiKeyExpiryNotifications } from './apiKeyExpiryNotificationService';

export class ApiKeyExpiryNotificationSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly; run body is cheap + deduped
  private lastRunDayKey: string | null = null;

  start(): void {
    if (this.intervalId) {
      console.log('[ApiKeyExpiryNotificationScheduler] Service already running');
      return;
    }

    console.log(
      '[ApiKeyExpiryNotificationScheduler] Starting — checking hourly; notifies at most once per day window',
    );
    setTimeout(() => void this.run(), 3 * 60 * 1000);
    this.intervalId = setInterval(() => void this.run(), this.CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[ApiKeyExpiryNotificationScheduler] Service stopped');
    }
  }

  /** Test helper — force a run regardless of day gate. */
  async runNowForTests(now: Date = new Date()): Promise<void> {
    this.lastRunDayKey = null;
    await this.execute(now);
  }

  private dayKey(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  private async run(): Promise<void> {
    const now = new Date();
    const key = this.dayKey(now);
    // Run once per UTC day after startup stagger (hourly tick re-checks).
    if (this.lastRunDayKey === key) return;
    await this.execute(now);
  }

  private async execute(now: Date): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const result = await runApiKeyExpiryNotifications(now);
      this.lastRunDayKey = this.dayKey(now);
      console.log(
        `[ApiKeyExpiryNotificationScheduler] keysScanned=${result.keysScanned} notificationsAttempted=${result.notificationsAttempted}`,
      );
    } catch (err) {
      console.error(
        '[ApiKeyExpiryNotificationScheduler] Error during run:',
        (err as Error).message,
      );
    } finally {
      this.isRunning = false;
    }
  }
}

export const apiKeyExpiryNotificationScheduler =
  new ApiKeyExpiryNotificationSchedulerService();
