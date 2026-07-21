import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the notification bell and notification center.
 * Covers unread badge, opening the center, mark-read, and preferences.
 */
export class NotificationCenterPage {
  constructor(private readonly page: Page) {}

  /** Dismiss auto-open overlays that would block the bell. */
  async dismissOverlays(): Promise<void> {
    await dismissOverlays(this.page);
  }

  // ── Bell icon ─────────────────────────────────────────────────────────────

  /** Locator for the notification bell button in the header. */
  bell() {
    return this.page.getByRole('button', { name: /notifications?/i });
  }

  /** Click the notification bell to open/close the center. */
  async clickBell(): Promise<void> {
    await this.bell().click();
  }

  /**
   * Returns the unread notification count shown in the badge.
   * Returns 0 when no badge is visible.
   */
  async getUnreadCount(): Promise<number> {
    // The bell may render a badge element with the count as text.
    const badge = this.page.locator('[data-testid="notification-badge"], .notification-badge, [aria-label*="unread"]');
    if (!(await badge.isVisible().catch(() => false))) return 0;
    const text = (await badge.textContent())?.trim();
    return parseInt(text ?? '0', 10) || 0;
  }

  // ── Notification center dropdown ──────────────────────────────────────────

  /** Wait for the notification panel to become visible (its heading appears). */
  async waitForPanelOpen(): Promise<void> {
    await this.page
      .getByRole('heading', { name: 'Notifications' })
      .waitFor({ state: 'visible', timeout: 5_000 });
  }

  /** Returns the titles of visible notification items in the panel. */
  async getNotificationTitles(): Promise<string[]> {
    const items = this.page.locator(
      '[data-testid^="notification-item-"], [class*="notification-item"]',
    );
    const titles: string[] = [];
    for (const item of await items.all()) {
      const text = (await item.textContent())?.trim();
      if (text) titles.push(text);
    }
    return titles;
  }

  /** Click "Mark all as read" if the button is visible. */
  async markAllRead(): Promise<void> {
    const btn = this.page.getByRole('button', { name: /mark.*all.*read|mark all/i });
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
    }
  }

  /** Returns true if the panel shows an empty state message. */
  async isEmptyStateVisible(): Promise<boolean> {
    return this.page
      .getByText(/no.*notification|all caught up|nothing here/i)
      .isVisible()
      .catch(() => false);
  }

  // ── Preferences page ──────────────────────────────────────────────────────

  /** Navigate to the notifications preferences page. */
  async gotoPreferences(): Promise<void> {
    await this.page.goto('/notifications');
    await this.page.waitForSelector('h1, [data-testid="notifications-preferences"]', {
      timeout: 10_000,
    });
  }
}
