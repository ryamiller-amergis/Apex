import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

/**
 * Page object for the AppSidebar navigation.
 *
 * DOM reality (see src/client/components/AppSidebar.tsx):
 * - "Home" button is rendered separately in the top section — NO data-testid.
 * - Module items (Calendar, Planning, Interview=backlog, Standup, etc.) carry
 *   data-testid="nav-item-{view}".
 * - "Admin" button is rendered in the bottom section — NO data-testid.
 *
 * So Home and Admin are matched by accessible role/name; module items by testid.
 */
export type ModuleView =
  | 'calendar'
  | 'planning'
  | 'cloudcost'
  | 'ai-cost'
  | 'backlog'
  | 'my-work'
  | 'standup'
  | 'ui-lab'
  | 'feature-requests'
  | 'pdf-tools'
  | 'design-module';

export class SidebarPage {
  constructor(private readonly page: Page) {}

  /** The sidebar nav landmark. */
  private nav() {
    return this.page.getByRole('navigation', { name: /main navigation/i });
  }

  /** Wait for the sidebar to be rendered and dismiss any auto-open overlays. */
  async waitForReady(): Promise<void> {
    await this.nav().waitFor({ state: 'visible', timeout: 15_000 });
    await dismissOverlays(this.page);
  }

  /** Click a module nav item by view key (uses data-testid). */
  async clickModule(view: ModuleView): Promise<void> {
    await this.page.getByTestId(`nav-item-${view}`).click();
  }

  /** Click the Home button (no testid — matched by role/name). */
  async clickHome(): Promise<void> {
    await this.nav().getByRole('button', { name: 'Home' }).click();
  }

  /** Click the Admin button (no testid — matched by role/name). */
  async clickAdmin(): Promise<void> {
    await this.nav().getByRole('button', { name: 'Admin' }).click();
  }

  /** Backwards-compatible generic nav click used by specs. */
  async clickNav(view: ModuleView | 'home' | 'admin'): Promise<void> {
    if (view === 'home') return this.clickHome();
    if (view === 'admin') return this.clickAdmin();
    return this.clickModule(view);
  }

  /** True if a module nav item is visible. */
  async isModuleVisible(view: ModuleView): Promise<boolean> {
    return this.page.getByTestId(`nav-item-${view}`).isVisible().catch(() => false);
  }

  /** True if the Home button is visible. */
  async isHomeVisible(): Promise<boolean> {
    return this.nav().getByRole('button', { name: 'Home' }).isVisible().catch(() => false);
  }

  /** True if the Admin button is visible. */
  async isAdminVisible(): Promise<boolean> {
    return this.nav().getByRole('button', { name: 'Admin' }).isVisible().catch(() => false);
  }

  /** Generic visibility check used by specs. */
  async isNavItemVisible(view: ModuleView | 'home' | 'admin'): Promise<boolean> {
    if (view === 'home') return this.isHomeVisible();
    if (view === 'admin') return this.isAdminVisible();
    return this.isModuleVisible(view);
  }
}
