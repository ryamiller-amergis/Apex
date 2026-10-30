/**
 * FEAT-002 — source-backed Brainstorm exploration.
 *
 * Covers the creator's sources tab, rejection of a private-network clone URL
 * before any clone starts, and ending a session. A full project-repository
 * clone needs an administrator mirror, so that path stays in the unit tests.
 */
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, SeedApi } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';

async function selectProject(page: Page, project: string): Promise<void> {
  await page.addInitScript((p) => {
    window.localStorage.setItem('selectedProject', p);
    window.localStorage.setItem('selectedAreaPath', p);
  }, project);
}

test.describe('Brainstorm sources @feat-002', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS]);
    await SeedApi.setBrainstormFlag(request, { enabled: true, projects: [E2E_PROJECT] });
    await stubAdoProjects(page);
  });

  test.afterAll(async ({ request }) => {
    await SeedApi.setBrainstormFlag(request, { enabled: false, projects: [] });
  });

  test('PBI-005 / PBI-006 / PBI-009: sources tab rejects a private URL and ends the session', async ({ page, loginAsPersona }) => {
    await selectProject(page, E2E_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/home');
    await page.getByTestId('brainstorm-start-session').click();
    await expect(page.getByTestId('brainstorm-workspace')).toBeVisible();

    await page.getByTestId('brainstorm-sources-tab').click();
    await expect(page.getByTestId('brainstorm-sources-panel')).toBeVisible();
    await expect(page.getByText('No sources yet')).toBeVisible();

    await page.getByTestId('brainstorm-add-source-button').click();
    await page.getByTestId('brainstorm-add-source-tab-temporary-repository').click();
    await page.getByTestId('brainstorm-temp-repo-url-input').fill('https://127.0.0.1/secret.git');
    await page.getByTestId('brainstorm-temp-repo-revision-input').fill('main');
    const attach = page.waitForResponse((response) =>
      response.url().includes('/sources') && response.request().method() === 'POST');
    await page.getByTestId('brainstorm-attach-source-button').click();
    const response = await attach;
    expect(response.status()).toBe(400);
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('brainstorm-sources-panel')).not.toContainText('Ready');

    await page.getByTestId('brainstorm-add-source-cancel').click();
    await page.getByTestId('brainstorm-end-session-button').click();
    await expect(page.getByTestId('brainstorm-end-session-dialog')).toContainText('Clones are deleted now');
    await page.getByTestId('brainstorm-end-session-confirm').click();
    await expect(page.getByTestId('brainstorm-session-status')).toHaveText('Ended');
    await expect(page.getByTestId('brainstorm-sources-ended-notice')).toBeVisible();
  });
});
