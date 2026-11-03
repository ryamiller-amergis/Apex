import type { Page } from '@playwright/test';
import { dismissOverlays } from '../support/overlays';

export class McpServersPage {
  constructor(private readonly page: Page) {}

  navItem() {
    return this.page.getByTestId('nav-item-mcp-servers');
  }

  async open(): Promise<void> {
    await dismissOverlays(this.page);
    await this.navItem().click();
    await this.page.getByTestId('mcp-servers-screen').waitFor({ state: 'visible' });
  }

  async createClerk(name: string, credential: string, allowedUserId: string): Promise<void> {
    await this.page.getByTestId('mcp-servers-name-input').fill(name);
    await this.page.getByTestId('mcp-servers-provider-select').selectOption('clerk');
    await this.page.getByTestId('mcp-servers-credential-input').fill(credential);
    await this.page.getByTestId('mcp-servers-allowed-users-input').fill(allowedUserId);
    await this.page.getByTestId('mcp-servers-save').click();
  }

  connectionRow(name: string) {
    return this.page.getByTestId('mcp-servers-connection-row').filter({ hasText: name });
  }

  async ask(connectionName: string, question: string): Promise<void> {
    await this.page.getByTestId('mcp-servers-connection-select').selectOption({ label: connectionName });
    await this.page.getByTestId('mcp-servers-question').fill(question);
    await this.page.getByTestId('mcp-servers-ask').click();
  }
}
