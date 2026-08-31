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
    return this.approvalModeOption('design_doc', 'any_one');
  }

  approvalModeAllRequired() {
    return this.approvalModeOption('design_doc', 'all_required');
  }

  approvalMode(module: string) {
    return this.page.getByTestId(`ps-approval-mode-${module}`);
  }

  approvalModeOption(module: string, mode: 'any_one' | 'all_required') {
    return this.page.getByTestId(`ps-approval-mode-${module}-${mode.replace('_', '-')}`);
  }

  noReviewersHelper(module: string) {
    return this.page.getByTestId(`ps-no-reviewers-helper-${module}`);
  }

  approverPool(module: string) {
    return this.page.getByTestId(`ps-${module}-approver-pool`);
  }

  async editConfig(settingsId: string): Promise<void> {
    await this.page.getByTestId(`ps-config-edit-${settingsId}`).click();
  }

  async openReviewers(): Promise<void> {
    await this.page.getByRole('button', { name: /Reviewers/i }).click();
  }

  async addApprover(module: string, searchText: string): Promise<void> {
    const pool = this.approverPool(module);
    await pool.getByPlaceholder('Search groups or people to add…').fill(searchText);
    await pool.getByRole('button', { name: new RegExp(searchText, 'i') }).first().click();
  }

  async save(): Promise<void> {
    await this.page.getByTestId('ps-form-save').click();
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
