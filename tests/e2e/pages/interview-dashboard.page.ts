import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the Interviews dashboard (/backlog).
 * Covers the Interviews, PRDs, Design Prototypes, and Design Docs tabs.
 */
export class InterviewDashboardPage {
  constructor(private readonly page: Page) {}

  /** Navigate to the backlog/interviews area. */
  async goto(): Promise<void> {
    await this.page.goto('/backlog');
    await this.waitForReady();
  }

  /** Wait until the Interviews dashboard heading is visible. */
  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.waitForSelector(
      '[data-testid="interviews-dashboard"], h1, h2',
      { timeout: 10_000 },
    );
  }

  /** The "Start New Interview" button (always rendered; enabled per RBAC + group). */
  startInterviewButton() {
    return this.page.getByRole('button', { name: /start new interview/i });
  }

  /** Returns true if the "Start New Interview" button is visible. */
  async isStartInterviewButtonVisible(): Promise<boolean> {
    return this.startInterviewButton().isVisible();
  }

  /** Returns true if the "Start New Interview" button is enabled. */
  async isStartInterviewButtonEnabled(): Promise<boolean> {
    return this.startInterviewButton().isEnabled();
  }

  /** Click the "Start New Interview" button. */
  async clickStartNewInterview(): Promise<void> {
    await this.startInterviewButton().click();
  }

  /**
   * The dashboard section selector is rendered as buttons labelled
   * "Interviews (N)", "PRDs (N)", etc. — not ARIA tabs.
   */
  tabButton(tabName: 'Interviews' | 'PRDs' | 'Design Prototypes' | 'Design Docs') {
    return this.page.getByRole('button', { name: new RegExp(`^${tabName}\\s*\\(`) });
  }

  /** Click the named section button. */
  async clickTab(tabName: 'Interviews' | 'PRDs' | 'Design Prototypes' | 'Design Docs'): Promise<void> {
    await this.tabButton(tabName).click();
  }

  /** Returns the text of interview cards currently visible. */
  async getInterviewTitles(): Promise<string[]> {
    const cards = this.page.getByRole('listitem').filter({ hasText: /Interview/i });
    const titles: string[] = [];
    for (const card of await cards.all()) {
      const text = (await card.textContent())?.trim();
      if (text) titles.push(text);
    }
    return titles;
  }
}
