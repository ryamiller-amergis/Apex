import type { Page, Locator } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the Scrum Calendar view (/calendar).
 * Covers work-item drag/drop scheduling, the details panel, and failure states.
 */
export class CalendarPage {
  constructor(private readonly page: Page) {}

  /** Navigate to the calendar. */
  async goto(): Promise<void> {
    await this.page.goto('/calendar');
    await this.waitForReady();
  }

  /** Wait until the calendar grid or unscheduled list is visible. */
  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    // react-big-calendar always renders `.rbc-calendar`; the sidebar renders the
    // unscheduled list. Either proves the calendar view mounted (not a redirect).
    await this.page.waitForSelector(
      '.rbc-calendar, [data-testid="unscheduled-list"]',
      { timeout: 15_000 },
    );
  }

  // ── Unscheduled items ─────────────────────────────────────────────────────

  /** Locator for the unscheduled items sidebar. */
  unscheduledList(): Locator {
    return this.page.locator('[data-testid="unscheduled-list"]').first();
  }

  /**
   * The unscheduled sidebar renders collapsed by default (only a toggle button).
   * Expand it so the work-item cards are present in the DOM.
   */
  async expandUnscheduledList(): Promise<void> {
    const list = this.unscheduledList();
    await list.waitFor({ state: 'visible', timeout: 10_000 });
    if ((await list.getAttribute('class'))?.includes('collapsed')) {
      // The toggle button's accessible name is a glyph (▶/◀), so target it by class.
      await list.locator('.collapse-toggle').click();
    }
    await this.page.locator('.work-item-card').first().waitFor({ state: 'visible', timeout: 10_000 });
  }

  /** Locator for a work-item card by title (within the unscheduled sidebar). */
  workItemCard(title: string): Locator {
    return this.page.locator('.work-item-card').filter({ hasText: title }).first();
  }

  /** Locator for an unscheduled item card by title. */
  unscheduledItem(title: string): Locator {
    return this.unscheduledList().getByText(title, { exact: false }).first();
  }

  /** Returns titles of all items currently in the unscheduled list. */
  async getUnscheduledItemTitles(): Promise<string[]> {
    const items = this.unscheduledList().locator('[data-testid^="work-item-"], [class*="work-item"]');
    const titles: string[] = [];
    for (const item of await items.all()) {
      const text = (await item.textContent())?.trim();
      if (text) titles.push(text);
    }
    return titles;
  }

  // ── Calendar cells ────────────────────────────────────────────────────────

  /**
   * Drag an unscheduled item onto a calendar date cell.
   * Uses Playwright's dragTo which requires both elements to be visible.
   */
  async dragItemToDate(itemTitle: string, targetDateLabel: string): Promise<void> {
    const source = this.unscheduledItem(itemTitle);
    const target = this.page
      .locator(`.rbc-day-bg, [data-date="${targetDateLabel}"], [aria-label*="${targetDateLabel}"]`)
      .first();

    await source.dragTo(target);
  }

  // ── Due-date reason modal ─────────────────────────────────────────────────

  /** Wait for the reason-for-date change modal to appear. */
  async waitForReasonModal(): Promise<void> {
    await this.page.waitForSelector(
      '[role="dialog"], [data-testid="reason-modal"]',
      { timeout: 5_000 },
    );
  }

  /** Fill in the reason text field and confirm the date change. */
  async submitReason(reason: string): Promise<void> {
    const input = this.page.getByRole('textbox').or(this.page.getByPlaceholder(/reason/i)).first();
    await input.fill(reason);
    await this.page.getByRole('button', { name: /confirm|submit|save/i }).click();
  }

  // ── Details panel ─────────────────────────────────────────────────────────

  /** Click a calendar work-item event to open the details panel. */
  async openDetailsPanel(itemTitle: string): Promise<void> {
    await this.page
      .locator('.rbc-event, [data-testid^="calendar-event-"]')
      .filter({ hasText: itemTitle })
      .first()
      .click();

    await this.page.waitForSelector('[data-testid="details-panel"], [class*="details-panel"]', {
      timeout: 5_000,
    });
  }

  /** Edit the title in the details panel. */
  async editDetailsTitle(newTitle: string): Promise<void> {
    const titleField = this.page
      .getByRole('textbox', { name: /title/i })
      .or(this.page.getByPlaceholder(/title/i))
      .first();
    await titleField.fill(newTitle);
  }

  /** Returns true if the details panel is currently visible. */
  async isDetailsPanelOpen(): Promise<boolean> {
    return this.page
      .locator('[data-testid="details-panel"], [class*="details-panel"]')
      .isVisible()
      .catch(() => false);
  }
}
