import type { Page } from '@playwright/test';

/**
 * Page object for the "Create ADO Items" modal (CreateAdoItemsModal.tsx).
 * The modal lets users select PBIs from an approved PRD and export them
 * to Azure DevOps. ADO calls are always stubbed in E2E tests.
 */
export class AdoExportModalPage {
  constructor(private readonly page: Page) {}

  // ── Trigger ───────────────────────────────────────────────────────────────

  /** Click the "Create in ADO" / export button on the PRD review page. */
  async openFromPrdReview(): Promise<void> {
    const trigger = this.page.getByRole('button', { name: /create.*ado|export.*ado/i });
    await trigger.click();
    await this.waitForReady();
  }

  /** Wait until the ADO export modal is open and the work-item list is visible. */
  async waitForReady(): Promise<void> {
    await this.page.waitForSelector(
      '[data-testid="summary-bar"], [role="dialog"][aria-label*="ADO"], [class*="ado-modal"]',
      { timeout: 10_000 },
    );
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  /** Returns the summary bar text (e.g. "3 items selected"). */
  async getSummaryBarText(): Promise<string> {
    const bar = this.page.getByTestId('summary-bar');
    return (await bar.textContent()) ?? '';
  }

  /** Select all items using the "select all" checkbox or button. */
  async selectAll(): Promise<void> {
    const selectAllCheckbox = this.page.getByRole('checkbox', { name: /select.*all|all/i }).first();
    if (!(await selectAllCheckbox.isChecked())) {
      await selectAllCheckbox.click();
    }
  }

  /** Toggle the checkbox for a specific work item by title. */
  async toggleItem(title: string): Promise<void> {
    await this.page.getByText(title, { exact: false }).locator('..').getByRole('checkbox').click();
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  /** Click the submit / export button to trigger the ADO export. */
  async submit(): Promise<void> {
    await this.page.getByRole('button', { name: /create.*items|export|submit/i }).click();
  }

  // ── Result states ─────────────────────────────────────────────────────────

  /** Returns true when the success confirmation panel is shown. */
  async isSuccessVisible(): Promise<boolean> {
    return this.page.getByTestId('ado-create-success').isVisible().catch(() => false);
  }

  /** Returns true when the error banner is shown. */
  async isErrorVisible(): Promise<boolean> {
    return this.page.getByTestId('ado-create-error').isVisible().catch(() => false);
  }

  /** Close the modal. */
  async close(): Promise<void> {
    const closeBtn = this.page.getByRole('button', { name: /close|cancel|×/i }).first();
    await closeBtn.click();
  }
}
