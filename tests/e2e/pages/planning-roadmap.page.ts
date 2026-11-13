import type { Locator, Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

export class PlanningRoadmapPage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/planning/roadmap');
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page
      .getByTestId('roadmap-workbench')
      .waitFor({ state: 'visible', timeout: 20_000 });
  }

  horizonColumn(horizon: 'now' | 'next' | 'later' | 'unplanned'): Locator {
    return this.page.getByTestId(`roadmap-horizon-col-${horizon}`);
  }

  modeButton(mode: 'horizons' | 'timeline' | 'sheet' | 'history'): Locator {
    return this.page.getByTestId(`roadmap-mode-${mode}`);
  }

  inspector(): Locator {
    return this.page.getByTestId('roadmap-inspector');
  }

  unscheduledTray(): Locator {
    return this.page.getByTestId('roadmap-unscheduled-tray');
  }

  sheetTable(): Locator {
    return this.page.getByTestId('roadmap-sheet-table');
  }

  historyTable(): Locator {
    return this.page.getByTestId('roadmap-history-table');
  }

  async switchMode(
    mode: 'horizons' | 'timeline' | 'sheet' | 'history',
  ): Promise<void> {
    await this.modeButton(mode).click();
  }

  async selectItemByTitle(title: string): Promise<void> {
    await this.page.getByRole('button', { name: title, exact: true }).first().click();
    await this.inspector().waitFor({ state: 'visible', timeout: 8_000 });
  }

  async createAdhocIdea(params: {
    title: string;
    ownerLabel?: string;
    horizon?: 'now' | 'next' | 'later' | 'unplanned';
    effortSize?: 'S' | 'M' | 'L' | 'XL';
    plannedStartDate?: string;
    plannedTargetDate?: string;
    notes?: string;
  }): Promise<void> {
    await this.page.getByTestId('roadmap-new-idea-btn').click();
    await this.page
      .getByTestId('roadmap-new-idea-modal')
      .waitFor({ state: 'visible', timeout: 5_000 });

    await this.page.getByTestId('roadmap-idea-title-input').fill(params.title);
    if (params.ownerLabel) {
      await this.page
        .getByTestId('roadmap-idea-owner-input')
        .fill(params.ownerLabel);
    }
    if (params.horizon) {
      await this.page
        .getByTestId('roadmap-idea-horizon-select')
        .selectOption(params.horizon);
    }
    if (params.effortSize) {
      await this.page
        .getByTestId('roadmap-idea-effort-select')
        .selectOption(params.effortSize);
    }
    if (params.plannedStartDate) {
      await this.page
        .getByTestId('roadmap-idea-start-date-input')
        .fill(params.plannedStartDate);
    }
    if (params.plannedTargetDate) {
      await this.page
        .getByTestId('roadmap-idea-target-date-input')
        .fill(params.plannedTargetDate);
    }
    if (params.notes) {
      await this.page
        .getByTestId('roadmap-idea-notes-input')
        .fill(params.notes);
    }

    await this.page.getByTestId('roadmap-create-idea-submit').click();
    await this.page
      .getByTestId('roadmap-new-idea-modal')
      .waitFor({ state: 'hidden', timeout: 8_000 });
  }
}
