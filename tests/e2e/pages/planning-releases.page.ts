import type { Locator, Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for Planning (/planning/*) and Generic Release Management (/planning/releases).
 */
export class PlanningReleasesPage {
  constructor(private readonly page: Page) {}

  async gotoPlanningRoot(): Promise<void> {
    await this.page.goto('/planning');
    await this.waitForPlanningTabs();
  }

  async gotoReleases(): Promise<void> {
    await this.page.goto('/planning/releases');
    await this.waitForReleasesWorkspace();
  }

  async waitForPlanningTabs(): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.getByTestId('planning-tabs').waitFor({ state: 'visible', timeout: 15_000 });
  }

  async waitForReleasesWorkspace(): Promise<void> {
    await this.waitForPlanningTabs();
    await this.page.locator('.release-view').waitFor({ state: 'visible', timeout: 15_000 });
  }

  planningTabsBar(): Locator {
    return this.page.getByTestId('planning-tabs');
  }

  roadmapTabButton(): Locator {
    return this.page.getByTestId('planning-tab-roadmap');
  }

  releasesTabButton(): Locator {
    return this.page.getByTestId('planning-tab-releases');
  }

  slatedOverview(): Locator {
    return this.page.getByTestId('release-slated-overview');
  }

  platformMatrix(): Locator {
    return this.page.getByTestId('slated-platform-breakdown');
  }

  managePlatformsButton(): Locator {
    return this.page.getByTestId('release-manage-platforms-btn');
  }

  platformsModal(): Locator {
    return this.page.getByTestId('release-platforms-modal');
  }

  async openManagePlatformsModal(): Promise<void> {
    await this.managePlatformsButton().click();
    await this.platformsModal().waitFor({ state: 'visible', timeout: 5_000 });
  }

  async addPresetPlatform(slug: string): Promise<void> {
    await this.page.getByTestId(`release-platform-preset-${slug}`).click();
    await this.page.getByTestId(`release-platform-row-${slug}`).waitFor({
      state: 'visible',
      timeout: 5_000,
    });
  }

  async closePlatformsModal(): Promise<void> {
    await this.page.getByTestId('release-platforms-modal-done').click();
    await this.platformsModal().waitFor({ state: 'hidden', timeout: 5_000 });
  }

  async selectLifecycleFilter(mode: 'all' | 'slated' | 'in-flight' | 'planned' | 'shipped'): Promise<void> {
    await this.page.getByTestId(`release-lifecycle-filter-${mode}`).click();
  }

  async selectPlatformFilter(slug: string): Promise<void> {
    await this.page.getByTestId(`release-platform-filter-${slug}`).click();
  }

  async expandReleaseRow(epicId: number): Promise<void> {
    await this.page.getByTestId(`release-expand-${epicId}`).click();
    await this.page.getByTestId(`release-expanded-overview-${epicId}`).waitFor({
      state: 'visible',
      timeout: 5_000,
    });
  }

  async filterExpandedItems(
    epicId: number,
    bucket: 'all' | 'left-to-validate' | 'uat-ready' | 'in-dev' | 'validated',
  ): Promise<void> {
    await this.page.getByTestId(`release-item-filter-${epicId}-${bucket}`).click();
  }

  async groupExpandedItemsBy(
    epicId: number,
    groupBy: 'none' | 'validation' | 'platform' | 'type',
  ): Promise<void> {
    await this.page.getByTestId(`release-item-group-by-${epicId}`).selectOption(groupBy);
  }

  async assignPlatformToWorkItem(
    epicId: number,
    itemId: number,
    platformSlug: string,
  ): Promise<void> {
    await this.page.getByTestId(`release-item-platform-btn-${epicId}-${itemId}`).click();
    await this.page
      .getByTestId(`release-item-platform-opt-${epicId}-${itemId}-${platformSlug}`)
      .click();
    // Close popover by clicking the button again
    await this.page.getByTestId(`release-item-platform-btn-${epicId}-${itemId}`).click();
  }

  async dragWorkItemToRelease(
    sourceEpicId: number,
    itemId: number,
    targetEpicId: number,
  ): Promise<void> {
    const cardSelector = `[data-testid="release-item-${sourceEpicId}-${itemId}"]`;
    const dropZoneSelector = `tr[data-release-drop="${targetEpicId}"] .release-item-drop-zone`;

    await this.page.locator(cardSelector).waitFor({ state: 'visible', timeout: 5_000 });

    // Dispatch synthetic HTML5 DragEvents so dragstart + requestAnimationFrame revealDropZones + drop run deterministically
    await this.page.evaluate(
      async ({ cardSel, dropSel, wiId }) => {
        const card = document.querySelector<HTMLElement>(cardSel);
        if (!card) throw new Error(`Card not found: ${cardSel}`);
        const dt = new DataTransfer();
        dt.setData('text/plain', String(wiId));
        card.dispatchEvent(
          new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const dropZone = document.querySelector<HTMLElement>(dropSel);
        if (!dropZone) throw new Error(`Drop zone not found: ${dropSel}`);
        dropZone.dispatchEvent(
          new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
        dropZone.dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
        dropZone.dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
        card.dispatchEvent(
          new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      },
      { cardSel: cardSelector, dropSel: dropZoneSelector, wiId: itemId },
    );
  }
}
