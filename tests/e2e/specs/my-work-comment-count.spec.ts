/**
 * E2E — ADO comment count badge on My Work rows (AB#55031).
 */
import { test, expect, E2E_PROJECT } from '../support/fixtures';
import { suppressSseStreams } from '../support/api-stubs';

const ASSIGNED_WORK_ITEMS = [
  {
    id: 55031,
    title: 'ADO Comment Count on My Work Rows',
    workItemType: 'Feature',
    state: 'In Progress',
    assignedTo: 'E2E Developer',
    project: E2E_PROJECT,
    tags: 'apex',
  },
  {
    id: 55032,
    title: 'Work item with no comments',
    workItemType: 'Bug',
    state: 'New',
    assignedTo: 'E2E Developer',
    project: E2E_PROJECT,
  },
];

async function stubMyWorkBoard(
  page: import('@playwright/test').Page,
  counts: Record<number, number | null>,
): Promise<void> {
  await page.route('**/api/dev-workbench/workitems*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ASSIGNED_WORK_ITEMS),
    });
  });

  await page.route('**/api/dev-workbench/sessions*', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
      return;
    }
    route.continue();
  });

  await page.route('**/api/dev-workbench/work-items/*/comment-count*', (route) => {
    const match = route.request().url().match(/work-items\/(\d+)\/comment-count/);
    const workItemId = match ? Number(match[1]) : 0;
    const count = counts[workItemId] ?? null;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ count }),
    });
  });
}

test.describe('My Work comment count badge @a11y', () => {
  test.beforeEach(async ({ page, loginAsPersona }) => {
    await suppressSseStreams(page);
    await loginAsPersona('developer');
  });

  test('shows badge when comment count is greater than zero', async ({ page }) => {
    await stubMyWorkBoard(page, { 55031: 3, 55032: null });

    await page.goto('/my-work');
    await expect(page.getByTestId('my-work-page')).toBeVisible();
    await expect(page.getByTestId('comment-count-badge-55031')).toHaveText('3');
    await expect(page.getByTestId('comment-count-badge-55031')).toHaveAttribute(
      'aria-label',
      '3 comments',
    );
  });

  test('omits badge when comment count is zero', async ({ page }) => {
    await stubMyWorkBoard(page, { 55031: null, 55032: null });

    await page.goto('/my-work');
    await expect(page.getByTestId('my-work-work-items-list')).toBeVisible();
    await expect(page.getByTestId('comment-count-badge-55031')).not.toBeVisible();
    await expect(page.getByTestId('comment-count-badge-55032')).not.toBeVisible();
  });

  test('row renders without badge when count API fails', async ({ page }) => {
    await page.route('**/api/dev-workbench/workitems*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ASSIGNED_WORK_ITEMS),
      });
    });
    await page.route('**/api/dev-workbench/sessions*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/api/dev-workbench/work-items/*/comment-count*', (route) => {
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"ADO down"}' });
    });

    await page.goto('/my-work');
    await expect(page.getByText('ADO Comment Count on My Work Rows')).toBeVisible();
    await expect(page.getByTestId('comment-count-badge-55031')).not.toBeVisible();
  });

  test('does not show badge on non–My Work views', async ({ page }) => {
    await stubMyWorkBoard(page, { 55031: 5 });

    await page.goto('/calendar');
    await expect(page.getByTestId('comment-count-badge-55031')).not.toBeVisible();
  });
});
