/**
 * @smoke @a11y
 * ADO comment count badge on My Work board rows (AB#55033).
 */
import AxeBuilder from '@axe-core/playwright';
import { test, expect, SeedApi, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams, suppressBetaAnnouncement } from '../support/api-stubs';
import { ProjectSelectorPage } from '../pages/project-selector.page';

const assignedWorkItems = [
  {
    id: 55001,
    title: 'Work item with comments',
    workItemType: 'Product Backlog Item',
    state: 'In Progress',
    assignedTo: 'dev@example.com',
    project: E2E_PROJECT,
    tags: 'apex',
  },
  {
    id: 55002,
    title: 'Work item without comments',
    workItemType: 'Product Backlog Item',
    state: 'New',
    assignedTo: 'dev@example.com',
    project: E2E_PROJECT,
    tags: 'apex',
  },
];

async function stubMyWorkApis(page: import('@playwright/test').Page) {
  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    const response = await route.fetch().catch(() => null);
    const data = response?.ok() ? await response.json().catch(() => ({})) : {};
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        flags: { ...(data?.flags ?? {}), 'work-board': false },
      }),
    });
  });

  await page.route('**/api/menu-config**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        enabledViews: ['my-work', 'home', 'calendar', 'backlog'],
      }),
    });
  });

  await page.route('**/api/dev-workbench/workitems?*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(assignedWorkItems),
    });
  });

  await page.route('**/api/dev-workbench/workitems/*/comment-count?*', (route) => {
    const url = route.request().url();
    const workItemId = Number.parseInt(url.match(/workitems\/(\d+)\/comment-count/)?.[1] ?? '0', 10);
    const count = workItemId === 55001 ? 3 : null;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count }),
    });
  });

  await page.route('**/api/dev-workbench/sessions?*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

test.describe('My Work comment count badge @smoke @a11y', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('shows badge for positive comment count and hides zero-count rows', async ({
    page,
    loginAsPersona,
  }) => {
    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await stubMyWorkApis(page);
    await loginAsPersona('developer');

    const selector = new ProjectSelectorPage(page);
    await selector.goto();
    if (!page.url().includes('/home')) {
      await selector.selectProject(E2E_PROJECT);
    }

    await page.goto('/my-work', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('my-work-page')).toBeVisible();
    await expect(page.getByTestId('my-work-work-items-list')).toBeVisible();
    await expect(page.getByText('Work item with comments')).toBeVisible();

    const badge = page.getByTestId('comment-count-badge-55001');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('3');
    await expect(badge).toHaveAttribute('aria-label', '3 comments');

    await expect(page.getByTestId('comment-count-badge-55002')).toHaveCount(0);
  });

  test('does not show comment count badges on non–My Work views', async ({
    page,
    loginAsPersona,
  }) => {
    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await stubMyWorkApis(page);
    await loginAsPersona('developer');

    await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('comment-count-badge')).toHaveCount(0);
    await expect(page.locator('[data-testid^="comment-count-badge-"]')).toHaveCount(0);
  });

  test('My Work page with badges has no critical a11y violations', async ({
    page,
    loginAsPersona,
  }) => {
    await suppressSseStreams(page);
    await suppressBetaAnnouncement(page);
    await stubAdoProjects(page);
    await stubMyWorkApis(page);
    await loginAsPersona('developer');

    const selector = new ProjectSelectorPage(page);
    await selector.goto();
    if (!page.url().includes('/home')) {
      await selector.selectProject(E2E_PROJECT);
    }

    await page.goto('/my-work', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('my-work-work-items-list')).toBeVisible();
    await expect(page.getByTestId('comment-count-badge-55001')).toBeVisible({ timeout: 15_000 });

    const whatsNewDismiss = page.getByRole('button', { name: /dismiss what's new/i });
    if (await whatsNewDismiss.isVisible().catch(() => false)) {
      await whatsNewDismiss.click();
    }

    const results = await new AxeBuilder({ page })
      .include('[data-testid="comment-count-badge-55001"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();

    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    );
    if (serious.length > 0) {
      throw new Error(
        `Badge a11y violations: ${serious.map((v) => `${v.id} (${v.impact})`).join(', ')}`,
      );
    }
    expect(serious.length).toBe(0);
  });
});
