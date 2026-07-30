import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the interview chat view (/backlog/interview/:id).
 */
export class InterviewChatPage {
  constructor(private readonly page: Page) {}

  async goto(interviewId: string): Promise<void> {
    await this.page.goto(`/backlog/interview/${interviewId}`);
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.waitForSelector(
      '[data-testid="interview-status-badge"], h1',
      { timeout: 15_000 },
    );
  }

  statusBadge() {
    return this.page.getByTestId('interview-status-badge');
  }

  completeButton() {
    return this.page.getByTestId('complete-interview-btn');
  }

  reopenButton() {
    return this.page.getByTestId('reopen-interview-btn');
  }

  archiveButton() {
    return this.page.getByTestId('archive-interview-btn');
  }

  generatePrdButton() {
    return this.page.getByTestId('generate-prd-btn');
  }

  ownerChips() {
    return this.page.getByTestId('interview-owner-chips');
  }

  async getStatusText(): Promise<string> {
    return ((await this.statusBadge().textContent()) ?? '').trim();
  }

  async clickComplete(): Promise<void> {
    await this.completeButton().click();
  }

  async clickReopen(): Promise<void> {
    await this.reopenButton().click();
  }

  async clickArchive(): Promise<void> {
    await this.archiveButton().click();
  }

  async clickGeneratePrd(): Promise<void> {
    await this.generatePrdButton().click();
  }
}
