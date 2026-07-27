import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for design prototype review (/backlog/design-prototypes/:prdId).
 */
export class PrototypeReviewPage {
  constructor(private readonly page: Page) {}

  async goto(prdId: string): Promise<void> {
    await this.page.goto(`/backlog/design-prototypes/${prdId}`);
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.waitForSelector(
      '[data-testid="prototype-review"], h1, .emptyState',
      { timeout: 15_000 },
    );
  }

  root() {
    return this.page.getByTestId('prototype-review');
  }

  statusBadge() {
    return this.page.getByTestId('prototype-status-badge');
  }

  approveButton() {
    return this.page.getByTestId('prototype-approve-btn');
  }

  approveOwnerButton() {
    return this.page.getByTestId('prototype-approve-owner-btn');
  }

  requestChangesButton() {
    return this.page.getByTestId('prototype-request-changes-btn');
  }

  regenerateButton() {
    return this.page.getByTestId('prototype-regenerate-btn');
  }

  async clickApprove(): Promise<void> {
    await this.approveButton().click();
  }

  async clickApproveOwner(): Promise<void> {
    await this.approveOwnerButton().click();
  }

  async clickRequestChanges(reason = 'E2E: please revise the layout'): Promise<void> {
    await this.requestChangesButton().click();
    const dialog = this.page.getByRole('dialog', { name: /request changes/i });
    await dialog.waitFor({ state: 'visible', timeout: 5_000 });
    await dialog.getByRole('textbox').fill(reason);
    await dialog.getByRole('button', { name: /^request changes$/i }).click();
  }
}
