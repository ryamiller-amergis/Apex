import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

export class IntegrationsPage {
  constructor(private readonly page: Page) {}

  navItem() {
    return this.page.getByTestId('nav-item-integrations');
  }

  async open(): Promise<void> {
    await dismissOverlays(this.page);
    await this.navItem().click();
    await this.page.getByTestId('integrations-screen').waitFor({ state: 'visible' });
  }

  async createClerk(name: string, credential: string, allowedUserId: string): Promise<void> {
    await this.page.getByTestId('integrations-name-input').fill(name);
    await this.page.getByTestId('integrations-provider-select').selectOption('clerk');
    await this.page.getByTestId('integrations-credential-input').fill(credential);
    await this.page.getByTestId('integrations-allowed-users-input').fill(allowedUserId);
    await this.page.getByTestId('integrations-save').click();
  }

  connectionRow(name: string) {
    return this.page.getByTestId('integrations-connection-row').filter({ hasText: name });
  }

  async ask(connectionName: string, question: string): Promise<void> {
    await this.page.getByTestId('integrations-connection-select').selectOption({ label: connectionName });
    await this.page.getByTestId('integrations-question').fill(question);
    await this.page.getByTestId('integrations-ask').click();
  }
}
