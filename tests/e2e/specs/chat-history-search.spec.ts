/**
 * FEAT-002 / PBI-002 — Chat history sidebar search
 *
 * Covers:
 * - Typing a query shows flat recency-ranked results with plain snippets (AC-0)
 * - Failed search surfaces an error state (AC-1)
 * - Empty results show "No matching chats"; clearing restores date-grouped list (AC-3)
 * - Terms under 2 characters do not fire search (BR-003)
 *
 * Execution may be deferred when a Playwright environment is unavailable.
 * Unit/component coverage for the same ACs lives in:
 *   - src/client/hooks/__tests__/useChatThreads.test.ts
 *   - src/client/components/__tests__/ThreadHistorySidebar.test.tsx
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { SidebarPage } from '../pages/sidebar.page';
import type { Page } from '@playwright/test';

const SUMMARY_THREADS = [
  {
    id: 'thread-design',
    userId: 'user-1',
    title: 'Design Review',
    status: 'idle',
    kickoff: { project: 'MaxView', repo: 'AI-Pilot' },
    flagged: true,
    createdAt: '2026-07-25T10:00:00.000Z',
    lastActivityAt: '2026-07-25T12:00:00.000Z',
  },
  {
    id: 'thread-other',
    userId: 'user-1',
    title: 'Standup notes',
    status: 'idle',
    kickoff: { project: 'MaxView', repo: 'AI-Pilot' },
    flagged: false,
    createdAt: '2026-07-24T10:00:00.000Z',
    lastActivityAt: '2026-07-24T12:00:00.000Z',
  },
];

const SEARCH_RESULTS = [
  {
    ...SUMMARY_THREADS[0],
    match: {
      messageId: 'msg-1',
      role: 'user',
      snippet: 'We should revisit the design tokens for the sidebar.',
      matchedAt: '2026-07-25T11:30:00.000Z',
    },
    titleOnly: false,
  },
];

async function stubChatThreads(page: Page, opts?: { failSearch?: boolean }): Promise<void> {
  await page.route('**/api/chat/threads*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    // Exact thread by id — not used by this suite
    if (/\/api\/chat\/threads\/[^/?]+$/.test(url.pathname) && !url.pathname.endsWith('/threads')) {
      await route.continue();
      return;
    }

    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length >= 2) {
      if (opts?.failSearch) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Search failed' }),
        });
        return;
      }
      const body = q.toLowerCase().includes('zzzz') ? [] : SEARCH_RESULTS;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SUMMARY_THREADS),
    });
  });
}

async function openHistorySidebar(page: Page): Promise<void> {
  await page.getByRole('button', { name: /history/i }).first().click();
  await expect(page.getByTestId('history-search-input')).toBeVisible({ timeout: 10_000 });
}

// DEFERRED: Playwright env unavailable — global-setup requires TEST_DATABASE_URL /
// a reachable PostgreSQL 16 instance (migration failed with 3D000). Specs are authored
// and listable; AC coverage is asserted at unit/component tier until e2e DB is available.
test.describe.skip('Chat history sidebar search (FEAT-002 / PBI-002)', () => {
  test.beforeEach(async ({ page }) => {
    await stubAdoProjects(page);
  });

  test('TC-PBI-002-001 / AC-0: typing design shows flat results with plain snippets', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatThreads(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByTestId('history-search-input').fill('design');
    await expect(page.getByTestId('history-search-results')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('history-search-result-row')).toBeVisible();
    await expect(page.getByTestId('history-search-result-snippet')).toHaveText(
      /design tokens/i,
    );
    // No date-group headers while search is active
    await expect(page.getByText('Today', { exact: true })).toHaveCount(0);
    const snippet = page.getByTestId('history-search-result-snippet');
    await expect(snippet.locator('strong, b, em, mark')).toHaveCount(0);
  });

  test('TC-PBI-002-002 / AC-1: search failure shows history-search-error', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatThreads(page, { failSearch: true });
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByTestId('history-search-input').fill('design');
    await expect(page.getByTestId('history-search-error')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('history-search-input')).toBeEditable();
  });

  test('TC-PBI-002-004 / AC-3: empty state then clear restores date-grouped list', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatThreads(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByTestId('history-search-input').fill('zzzz');
    await expect(page.getByTestId('history-search-empty')).toHaveText('No matching chats');

    await page.getByTestId('history-search-input').fill('');
    await expect(page.getByTestId('history-search-empty')).toHaveCount(0);
    await expect(page.getByTestId('history-search-results')).toHaveCount(0);
    // Date-grouped list restored (at least one group header from seeded threads)
    await expect(page.locator('text=/Today|Yesterday|Last 7 Days|Older/').first()).toBeVisible({
      timeout: 5_000,
    });
  });

  test('TC-PBI-002-005 / BR-003: 1-char term does not switch to search results', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatThreads(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByTestId('history-search-input').fill('d');
    // Give debounce time; search UI must not activate
    await page.waitForTimeout(400);
    await expect(page.getByTestId('history-search-results')).toHaveCount(0);
    await expect(page.getByTestId('history-search-empty')).toHaveCount(0);
  });
});
