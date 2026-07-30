import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for Admin → Project Settings.
 */
export class AdminProjectSettingsPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/admin/project-settings');
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.waitForSelector(
      '[data-testid^="ps-stage-"], #ps-friendlyName, h1, h2',
      { timeout: 15_000 },
    );
  }

  stageCard(skillKey: string) {
    return this.page.getByTestId(`ps-stage-${skillKey}`);
  }

  approvalModeAnyOne() {
    return this.page.getByTestId('ps-approval-mode-any-one');
  }

  approvalModeAllRequired() {
    return this.page.getByTestId('ps-approval-mode-all-required');
  }

  validationThresholdInput() {
    return this.page.locator('#ps-validation-threshold');
  }

  designDocValidationThresholdInput() {
    return this.page.locator('#ps-dd-validation-threshold');
  }

  async selectApprovalMode(mode: 'any_one' | 'all_required'): Promise<void> {
    if (mode === 'any_one') {
      await this.approvalModeAnyOne().check({ force: true });
    } else {
      await this.approvalModeAllRequired().check({ force: true });
    }
  }
}
