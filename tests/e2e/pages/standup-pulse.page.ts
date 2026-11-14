import type { Page, Locator } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for AI-Led Standup Check-In (/standup), Scrum Master Readout (/standup-summary),
 * and Standup Management (/standup-manage).
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

  // ── Personal Check-In Locators ───────────────────────────────────────────

  deliveryModelBadge(): Locator {
    return this.page.getByTestId('standup-delivery-model-badge');
  }

  teamGoalBanner(): Locator {
    return this.page.getByTestId('standup-team-goal');
  }

  aiPromptCard(): Locator {
    return this.page.getByTestId('standup-ai-prompt-card');
  }

  yesterdayInput(): Locator {
    return this.page.getByTestId('standup-quick-yesterday');
  }

  todayInput(): Locator {
    return this.page.getByTestId('standup-quick-today');
  }

  blockersInput(): Locator {
    return this.page.getByTestId('standup-quick-blockers');
  }

  correctionsInput(): Locator {
    return this.page.getByTestId('standup-corrections-input');
  }

  quickConfirmSubmitBtn(): Locator {
    return this.page.getByTestId('standup-quick-submit-btn');
  }

  submittedBanner(): Locator {
    return this.page.getByTestId('standup-submitted-banner');
  }

  // ── Scrum Master Readout Locators ────────────────────────────────────────

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

  pulseFacilitatorPrompts(): Locator {
    return this.page.getByTestId('pulse-facilitator-prompts');
  }

  pulseIndividualNarrativesSection(): Locator {
    return this.page.getByTestId('pulse-individual-narratives-section');
  }

  pulseDeliveryInsights(): Locator {
    return this.page.getByTestId('pulse-delivery-insights');
  }

  pulseSdlcCalloutsSection(): Locator {
    return this.page.getByTestId('pulse-sdlc-callouts-section');
  }

  pulseAreaBreakdownSection(): Locator {
    return this.page.getByTestId('pulse-area-breakdown-section');
  }

  pulseProposalsSection(): Locator {
    return this.page.getByTestId('pulse-proposals-section');
  }
}
