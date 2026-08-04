import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object wrapping validation / fix-banner interactions shared by
 * PRD and design-doc review views.
 */
export class ValidationPanelPage {
  constructor(private readonly page: Page) {}

  async waitForPrdReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.waitForSelector('[data-testid="prd-review"]', { timeout: 15_000 });
  }

  prdReadinessPanel() {
    return this.page.getByTestId('prd-readiness-panel');
  }

  designDocFixBanner() {
    return this.page.getByTestId('dd-fix-banner');
  }

  proceedAnywayButton() {
    return this.page.getByRole('button', { name: /proceed anyway/i });
  }

  markReadyOrSubmitButton() {
    return this.page.getByRole('button', { name: /submit for review|mark ready/i });
  }

  async clickProceedAnyway(): Promise<void> {
    const btn = this.proceedAnywayButton();
    await btn.click();
    const confirm = this.page.getByRole('button', { name: /proceed anyway|confirm/i }).last();
    if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirm.click();
    }
  }
}
