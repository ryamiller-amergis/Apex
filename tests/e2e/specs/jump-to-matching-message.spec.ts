/**
 * FEAT-003 / PBI-003 — Jump to matching message
 *
 * Covers:
 * - Message-match result opens thread, scrolls, briefly highlights (AC-0 / TC-PBI-003-001)
 * - Missing matched message opens without highlight (AC-1 / TC-PBI-003-002)
 * - Title-only result opens without scroll/highlight (AC-2 / TC-PBI-003-003)
 * - Date-grouped open applies no highlight (AC-3 / TC-PBI-003-004)
 *
 * Execution may be deferred when a Playwright environment is unavailable.
 * Unit/component coverage for the same ACs lives in:
 *   - src/client/hooks/__tests__/useFocusChatMessage.test.tsx
 *   - src/client/components/__tests__/ThreadHistorySidebar.test.tsx
 *   - src/client/components/__tests__/selectChatThreadHandler.test.ts
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { SidebarPage } from '../pages/sidebar.page';
import type { Page } from '@playwright/test';

const MATCHED_MESSAGE_ID = 'msg-matched';

const THREAD_DETAIL = {
  id: 'thread-design',
  userId: 'user-1',
  title: 'Design Review',
  status: 'idle',
  kickoff: { project: 'MaxView', repo: 'AI-Pilot' },
  flagged: false,
  createdAt: '2026-07-25T10:00:00.000Z',
  lastActivityAt: '2026-07-25T12:00:00.000Z',
  workspaceDir: '/tmp/ws',
  messages: [
    {
      id: 'msg-other',
      role: 'user',
      text: 'Earlier context that is not the match.',
      ts: '2026-07-25T11:00:00.000Z',
    },
    {
      id: MATCHED_MESSAGE_ID,
      role: 'user',
      text: 'We should revisit the design tokens for the sidebar.',
      ts: '2026-07-25T11:30:00.000Z',
    },
    {
      id: 'msg-agent',
      role: 'agent',
      text: 'Agreed — I will draft a token update.',
      ts: '2026-07-25T11:31:00.000Z',
    },
  ],
};

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
];

const MESSAGE_MATCH_RESULT = {
  ...SUMMARY_THREADS[0],
  match: {
    messageId: MATCHED_MESSAGE_ID,
    role: 'user',
    snippet: 'We should revisit the design tokens for the sidebar.',
    matchedAt: '2026-07-25T11:30:00.000Z',
  },
  titleOnly: false,
};

const TITLE_ONLY_RESULT = {
  ...SUMMARY_THREADS[0],
  titleOnly: true,
};

const STALE_MATCH_RESULT = {
  ...SUMMARY_THREADS[0],
  match: {
    messageId: 'msg-gone',
    role: 'user',
    snippet: 'This message was removed.',
    matchedAt: '2026-07-25T11:30:00.000Z',
  },
  titleOnly: false,
};

async function stubChatApis(
  page: Page,
  opts: { searchResults?: unknown[]; threadMessages?: typeof THREAD_DETAIL.messages },
): Promise<void> {
  const threadBody = {
    ...THREAD_DETAIL,
    messages: opts.threadMessages ?? THREAD_DETAIL.messages,
  };

  await page.route('**/api/chat/threads*', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (method === 'GET' && /\/api\/chat\/threads\/[^/?]+$/.test(url.pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(threadBody),
      });
      return;
    }

    if (method !== 'GET') {
      await route.continue();
      return;
    }

    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length >= 2) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(opts.searchResults ?? [MESSAGE_MATCH_RESULT]),
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
test.describe.skip('Jump to matching message (FEAT-003 / PBI-003)', () => {
  test.beforeEach(async ({ page }) => {
    await stubAdoProjects(page);
  });

  test('TC-PBI-003-001 / AC-0: message-match scrolls and briefly highlights', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatApis(page, { searchResults: [MESSAGE_MATCH_RESULT] });
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByTestId('history-search-input').fill('design');
    await expect(page.getByTestId('history-search-result-row')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('history-search-result-row').getByRole('button', { name: /open thread/i }).click();

    await expect(page.getByTestId('chat-message-highlighted')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(`[data-message-id="${MATCHED_MESSAGE_ID}"]`)).toBeVisible();

    await expect(page.getByTestId('chat-message-highlighted')).toHaveCount(0, { timeout: 3_500 });
  });

  test('TC-PBI-003-002 / AC-1: missing matched message opens without highlight', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatApis(page, { searchResults: [STALE_MATCH_RESULT] });
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByTestId('history-search-input').fill('design');
    await page.getByTestId('history-search-result-row').getByRole('button', { name: /open thread/i }).click();

    await expect(page.getByText(/Earlier context that is not the match/i)).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(500);
    await expect(page.getByTestId('chat-message-highlighted')).toHaveCount(0);
  });

  test('TC-PBI-003-003 / AC-2: title-only opens without highlight', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatApis(page, { searchResults: [TITLE_ONLY_RESULT] });
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByTestId('history-search-input').fill('design');
    await page.getByTestId('history-search-result-row').getByRole('button', { name: /open thread/i }).click();

    await expect(page.getByText(/Earlier context that is not the match/i)).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(500);
    await expect(page.getByTestId('chat-message-highlighted')).toHaveCount(0);
  });

  test('TC-PBI-003-004 / AC-3: date-grouped open applies no highlight', async ({
    page,
    loginAsPersona,
  }) => {
    await stubChatApis(page, {});
    await loginAsPersona('developer');
    await page.goto('/home');

    const sidebar = new SidebarPage(page);
    await sidebar.waitForReady();
    await openHistorySidebar(page);

    await page.getByRole('button', { name: /open thread: design review/i }).click();
    await expect(page.getByText(/Earlier context that is not the match/i)).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(500);
    await expect(page.getByTestId('chat-message-highlighted')).toHaveCount(0);
  });
});
