import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the ProjectSelector screen ('/').
 * Shown when a logged-in user must pick among their assigned projects
 * (dev personas are seeded to MaxView and MatterWorx).
 */
export class ProjectSelectorPage {
  constructor(private readonly page: Page) {}

  /** Navigate to the root and wait for the selector to be interactable. */
  async goto(): Promise<void> {
    await this.page.goto('/');
    await this.waitForReady();
  }

  /** Wait until the selector is shown and dismiss any auto-open overlays. */
  async waitForReady(): Promise<void> {
    await this.page
      .getByText(/select a project|choose a project|planning to delivery/i)
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
    await dismissOverlays(this.page);
  }

  /** True if the project selector screen is currently shown. */
  async isVisible(): Promise<boolean> {
    return this.page
      .getByText(/select a project|choose a project/i)
      .first()
      .isVisible()
      .catch(() => false);
  }

  /** Click a project card by name and wait for navigation to /home. */
  async selectProject(projectName: string): Promise<void> {
    await dismissOverlays(this.page);
    await this.page.getByRole('button', { name: projectName, exact: true }).click();
    await this.page.waitForURL('**/home', { timeout: 15_000 });
  }
}
