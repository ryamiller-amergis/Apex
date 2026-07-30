import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for design doc review (/backlog/design-doc/:id).
 */
export class DesignDocReviewPage {
  constructor(private readonly page: Page) {}

  async goto(docId: string): Promise<void> {
    await this.page.goto(`/backlog/design-doc/${docId}`);
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.waitForSelector(
      '[data-testid="design-doc-review"], [data-testid="dd-status-badge"]',
      { timeout: 15_000 },
    );
  }

  root() {
    return this.page.getByTestId('design-doc-review');
  }

  statusBadge() {
    return this.page.getByTestId('dd-status-badge');
  }

  validationBadge() {
    return this.page.getByTestId('dd-validation-badge');
  }

  fixBanner() {
    return this.page.getByTestId('dd-fix-banner');
  }

  approveButton() {
    return this.page.getByTestId('dd-approve-btn');
  }

  approveOwnerButton() {
    return this.page.getByTestId('dd-approve-owner-btn');
  }

  submitButton() {
    return this.page.getByTestId('dd-submit-btn');
  }

  commentsDockTab() {
    return this.page.getByTestId('dd-dock-comments-tab');
  }

  validationDockTab() {
    return this.page.getByTestId('dd-dock-validation-tab');
  }

  validationScore() {
    return this.page.getByTestId('dd-validation-score');
  }

  async getStatusText(): Promise<string> {
    return ((await this.statusBadge().textContent()) ?? '').trim();
  }

  async openCommentsDock(): Promise<void> {
    const tab = this.commentsDockTab();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
    }
  }

  async openValidationDock(): Promise<void> {
    const tab = this.validationDockTab();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
    }
  }

  async clickApprove(): Promise<void> {
    await this.approveButton().click();
  }

  async clickApproveOwner(): Promise<void> {
    await this.approveOwnerButton().click();
  }

  async clickSubmit(): Promise<void> {
    await this.submitButton().click();
  }
}
