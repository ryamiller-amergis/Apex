import type { Page, Locator } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for Standup Ceremony (/standup), Team Pulse Summary (/standup-summary),
 * Standup Management (/standup-manage), and Calendar Delivery Pulse (/calendar).
 */
export class StandupPulsePage {
  constructor(private readonly page: Page) {}

  async gotoStandup(): Promise<void> {
    await this.page.goto('/standup');
    await dismissOverlays(this.page);
    await this.page
      .getByTestId('standup-subnav-my-standup')
      .waitFor({ state: 'visible', timeout: 15_000 });
  }

  async gotoSummaryNoParams(): Promise<void> {
    await this.page.goto('/standup-summary');
    await dismissOverlays(this.page);
    await this.page
      .getByTestId('standup-summary-sub-nav-btn-2')
      .waitFor({ state: 'visible', timeout: 15_000 });
  }

  async gotoManage(): Promise<void> {
    await this.page.goto('/standup-manage');
    await dismissOverlays(this.page);
    await this.page
      .getByRole('heading', { name: 'Standup Management' })
      .waitFor({ state: 'visible', timeout: 15_000 });
  }

  async gotoCalendar(): Promise<void> {
    await this.page.goto('/calendar');
    await dismissOverlays(this.page);
    await this.page
      .getByTestId('calendar-delivery-pulse-bar')
      .waitFor({ state: 'visible', timeout: 15_000 });
  }

  // ── Standup Ceremony Locators & Actions ──────────────────────────────────

  deliveryModelBadge(): Locator {
    return this.page.getByTestId('standup-delivery-model-badge');
  }

  teamGoalBanner(): Locator {
    return this.page.getByTestId('standup-team-goal');
  }

  quickConfirmSubmitBtn(): Locator {
    return this.page.getByTestId('standup-quick-submit-btn');
  }

  submittedBanner(): Locator {
    return this.page.getByTestId('standup-submitted-banner');
  }

  // ── Team Pulse Summary Locators ──────────────────────────────────────────

  pulseDeliveryModel(): Locator {
    return this.page.getByTestId('pulse-delivery-model');
  }

  pulseOverallHealth(): Locator {
    return this.page.getByTestId('pulse-overall-health');
  }

  pulseTeamGoal(): Locator {
    return this.page.getByTestId('pulse-team-goal');
  }

  pulseBlockersSection(): Locator {
    return this.page.getByTestId('pulse-blockers-section');
  }

  pulseRisksSection(): Locator {
    return this.page.getByTestId('pulse-risks-section');
  }

  pulseProposalsSection(): Locator {
    return this.page.getByTestId('pulse-proposals-section');
  }

  // ── Calendar Delivery Pulse Locators ─────────────────────────────────────

  calendarPulseBar(): Locator {
    return this.page.getByTestId('calendar-delivery-pulse-bar');
  }

  calendarProposalsDrawer(): Locator {
    return this.page.getByTestId('calendar-proposals-panel');
  }
}
