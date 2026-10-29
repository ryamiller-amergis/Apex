/**
 * ADR interview start should leave the compose form before the kickoff POST
 * finishes, and the composer should unlock once the agent reply is visible
 * even if the thread snapshot still says the run is running.
 */
import {
  test,
  expect,
  SeedApi,
  PERSONA_OIDS,
  E2E_PROJECT,
} from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';

const KICKOFF_PROMPT = 'Choose a queue for the order events and name the trade-off.';
const AGENT_REPLY = 'Use a queue with competing consumers.';

test.describe('ADR interview kickoff composer @interview-flow', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('shows the chat while kickoff is in flight and unlocks after the first reply', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'ADR kickoff composer',
      isDefault: true,
      approvalMode: 'any_one',
      adrApprovers: [PERSONA_OIDS.qa],
    });
    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await page.route('**/api/chat/threads', async (route) => {
      if (route.request().method() === 'POST') {
        await route.continue();
      } else {
        await route.fallback();
      }
    });

    let threadPhase: 'setup' | 'replied' = 'setup';
    let releaseMessages = (): void => {};
    const messagesHeld = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    let released = false;
    const releaseKickoff = (): void => {
      if (released) return;
      released = true;
      releaseMessages();
    };

    await page.route('**/api/chat/threads/*', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (route.request().method() === 'POST' && /\/messages$/.test(path)) {
        await messagesHeld;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, status: 'running' }),
        });
        return;
      }
      if (route.request().method() === 'GET' && /^\/api\/chat\/threads\/[^/]+$/.test(path)) {
        const threadId = path.split('/').pop();
        const replied = threadPhase === 'replied';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: threadId,
            userId: PERSONA_OIDS['product-owner'],
            kickoff: {
              project: E2E_PROJECT,
              repo: E2E_PROJECT,
              branch: 'main',
            },
            messages: replied
              ? [
                {
                  id: 'user-1',
                  role: 'user',
                  text: KICKOFF_PROMPT,
                  ts: '2026-10-27T20:00:00.000Z',
                },
                {
                  id: 'agent-1',
                  role: 'agent',
                  text: AGENT_REPLY,
                  ts: '2026-10-27T20:00:01.000Z',
                },
              ]
              : [],
            status: replied ? 'running' : 'idle',
            workspaceDir: '/tmp/e2e-adr',
            flagged: false,
            createdAt: '2026-10-27T20:00:00.000Z',
            lastActivityAt: '2026-10-27T20:00:01.000Z',
          }),
        });
        return;
      }
      await route.fallback();
    });

    try {
      await loginAsPersona('product-owner');
      await page.goto('/adr/new');
      await page.getByTestId('adr-compose-title').fill('Order event transport');
      await page.getByTestId('adr-compose-message').fill(KICKOFF_PROMPT);
      const start = page.getByTestId('adr-compose-start');
      await expect(start).toBeEnabled({ timeout: 15_000 });
      await start.click();
      await expect(page.getByTestId('adr-reviewer-modal')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('adr-reviewer-select-all-btn').click();
      await page.getByTestId('adr-reviewer-confirm-btn').click();

      await expect(page).toHaveURL(/\/adr\/(?!new$)[^/]+$/, { timeout: 20_000 });
      await expect(page.getByText(KICKOFF_PROMPT)).toBeVisible();
      await expect(page.getByTestId('adr-preparation-state')).toBeVisible();

      threadPhase = 'replied';
      releaseKickoff();

      await expect(page.getByText(AGENT_REPLY)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('adr-message-input')).toHaveAttribute(
        'placeholder',
        'Continue the ADR interview… (Enter to send)',
      );
      await expect(page.getByTestId('adr-message-input')).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
      await expect(page.getByTestId('adr-stop-btn')).toHaveCount(0);
    } finally {
      releaseKickoff();
    }
  });
});
