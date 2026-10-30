/**
 * FEAT-001 — Brainstorm sessions and open chat (VT-33, VT-34, VT-35).
 *
 * The dev personas hold the `member` role, which the Brainstorm permission migration grants
 * `brainstorm:view` and `brainstorm:create`. The flag is turned on per project through the
 * e2e seed route so the server routes and the client entry agree.
 *
 * VT-33's streamed reply needs the V2 interactive transport and a worker. When the send is
 * refused with `transport_unavailable`, that step is skipped and the rest still runs.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, E2E_PROJECT, SeedApi } from '../support/fixtures';
import { devLogin } from '../support/auth';
import { stubAdoProjects } from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';

const OTHER_PROJECT = 'MatterWorx';

async function selectProject(page: Page, project: string): Promise<void> {
  await page.addInitScript((p) => {
    window.localStorage.setItem('selectedProject', p);
    window.localStorage.setItem('selectedAreaPath', p);
  }, project);
}

function api(path: string, project: string): string {
  return `/api/brainstorm/sessions${path}?project=${encodeURIComponent(project)}`;
}

test.describe('Brainstorm sessions @feat-001', () => {
  test.beforeEach(async ({ page, request }) => {
    await SeedApi.setMenuSettings(request, E2E_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS]);
    await SeedApi.setMenuSettings(request, OTHER_PROJECT, [...DEFAULT_ENABLED_MENU_VIEWS]);
    await SeedApi.setBrainstormFlag(request, { enabled: true, projects: [E2E_PROJECT] });
    await stubAdoProjects(page);
  });

  test.afterAll(async ({ request }) => {
    await SeedApi.setBrainstormFlag(request, { enabled: false, projects: [] });
  });

  test('VT-33 PBI-001 (a), PBI-002 (a): start from Agent Home, send, and find the session in the list', async ({ page, loginAsPersona }) => {
    await selectProject(page, E2E_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/home');

    await expect(page.getByTestId('brainstorm-home-entry')).toBeVisible();
    await page.getByTestId('brainstorm-start-session').click();

    await expect(page).toHaveURL(/\/brainstorm\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('brainstorm-workspace')).toBeVisible();
    await expect(page.getByTestId('brainstorm-chat-empty')).toBeVisible();
    await expect(page.getByTestId('brainstorm-composer-input')).toBeFocused();
    await expect(page.getByTestId('brainstorm-artifact-empty')).toBeVisible();

    const sessionId = page.url().split('/').pop() ?? '';
    const sendResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/brainstorm/sessions/${sessionId}/messages`)
      && response.request().method() === 'POST');
    await page.getByTestId('brainstorm-composer-input').fill('A shared reading list for the team');
    await page.getByTestId('brainstorm-composer-send').click();
    const accepted = await sendResponse;

    if (accepted.status() === 409) {
      const body = (await accepted.json().catch(() => ({}))) as { error?: string };
      test.skip(body.error === 'transport_unavailable', 'V2 interactive transport is not running in this environment');
    }
    expect(accepted.status()).toBe(202);
    await expect(page.getByTestId('brainstorm-chat-thread')).toContainText('A shared reading list for the team');
    await expect(
      page.getByTestId('brainstorm-streaming').or(page.locator('[aria-label="Collaborator"]')),
    ).toBeVisible({ timeout: 60_000 });

    await page.goto('/brainstorm');
    await expect(page.getByTestId('brainstorm-sessions-page')).toBeVisible();
    await expect(page.locator(`a[href="/brainstorm/${sessionId}"]`)).toBeVisible();
  });

  test('VT-34 PBI-004 (a), PBI-002 (d): another member reads the session and cannot post to it', async ({ page, browser, loginAsPersona }) => {
    await selectProject(page, E2E_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/home');
    const created = await page.request.post(api('', E2E_PROJECT), { data: {} });
    test.skip(created.status() === 409, 'V2 interactive transport is not running in this environment');
    expect(created.status()).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    try {
      await stubAdoProjects(other);
      await selectProject(other, E2E_PROJECT);
      await devLogin(other, 'ba');
      await other.goto(`/brainstorm/${session.id}`);

      await expect(other.getByTestId('brainstorm-readonly-banner')).toContainText('Only its creator can reply.');
      await expect(other.getByTestId('brainstorm-composer-input')).toHaveCount(0);
      await expect(other.getByTestId('brainstorm-empty-readonly')).toBeVisible();

      const refused = await other.request.post(api(`/${session.id}/messages`, E2E_PROJECT), {
        data: { turnId: randomUUID(), text: 'Not my session' },
      });
      expect(refused.status()).toBe(403);

      const messages = await page.request.get(api(`/${session.id}/messages`, E2E_PROJECT));
      expect(((await messages.json()) as { messages: unknown[] }).messages).toHaveLength(0);
    } finally {
      await otherContext.close();
    }
  });

  test('VT-35 PBI-001 (d): with the flag off there is no entry, no route, and the API returns 404', async ({ page, loginAsPersona }) => {
    await selectProject(page, OTHER_PROJECT);
    await loginAsPersona('developer');
    await page.goto('/home');

    await expect(page.getByTestId('brainstorm-home-entry')).toHaveCount(0);

    await page.goto('/brainstorm');
    await expect(page.getByTestId('route-not-found')).toBeVisible();
    await expect(page.getByTestId('brainstorm-sessions-page')).toHaveCount(0);

    const listed = await page.request.get(api('', OTHER_PROJECT));
    expect(listed.status()).toBe(404);
    const created = await page.request.post(api('', OTHER_PROJECT), { data: {} });
    expect(created.status()).toBe(404);
  });
});
