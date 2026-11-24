/**
 * @a11y
 * Accessibility audits using @axe-core/playwright.
 *
 * Scans critical pages for WCAG 2.1 Level A and AA violations.
 * Tests fail on violations tagged "critical" or "serious" — these represent
 * genuine accessibility barriers for users with disabilities. Minor and
 * moderate violations are reported but do not fail the suite during the
 * baseline stabilization period.
 *
 * Pages audited (Tier 0 scope):
 * - Login / project selector
 * - Home (/home)
 * - Interview dashboard (/backlog)
 * - PRD review (/backlog/prd/:id)
 * - Calendar (/calendar)
 * - Notifications preferences (/notifications)
 */
import net from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import type { Page, WebSocketRoute } from '@playwright/test';
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import {
  stubAdoProjects,
  stubAdoWorkItems,
  suppressBetaAnnouncement,
  suppressSseStreams,
} from '../support/api-stubs';
import type {
  HarnessReceipt,
  HarnessThreadSnapshot,
  HarnessThreadState,
} from '../../../src/shared/types/chatHarness';

/** Run an axe scan and assert no critical/serious violations. */
async function assertNoSeriousViolations(page: import('@playwright/test').Page, pageName: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();

  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );

  if (serious.length > 0) {
    const details = serious
      .map((v) => `  [${v.impact}] ${v.id}: ${v.description}\n    ${v.nodes[0]?.html ?? ''}`)
      .join('\n');
    throw new Error(`Accessibility violations on ${pageName} (${serious.length}):\n${details}`);
  }

  // Report minor/moderate violations as informational warnings.
  const minor = results.violations.filter(
    (v) => v.impact === 'minor' || v.impact === 'moderate',
  );
  if (minor.length > 0) {
    console.warn(
      `[a11y] ${pageName}: ${minor.length} minor/moderate violation(s) — not failing.`,
    );
  }

  expect(serious.length).toBe(0);
}

/**
 * The main navigation landmark rendered by AppSidebar on every authenticated
 * page. Waiting for it is a deterministic signal that the app shell has
 * hydrated — unlike `networkidle`, which never settles because Apex keeps the
 * network busy via the SSE notification stream and POLL_INTERVAL polling.
 */
function mainNav(page: import('@playwright/test').Page) {
  return page.getByRole('navigation', { name: /main navigation/i });
}

test.describe('Accessibility audits @a11y', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('login/project selector has no critical a11y violations', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // Unauthenticated visit renders the Split Gate login page.
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Continue with your Amergis account.')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /sign in with amergis sso/i }),
    ).toBeVisible();
    await assertNoSeriousViolations(page, 'Login/Project Selector');
  });

  test('/home has no critical a11y violations', async ({ page, loginAsPersona }) => {
    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home', { waitUntil: 'domcontentloaded' });
    await expect(mainNav(page)).toBeVisible();
    await assertNoSeriousViolations(page, '/home');
  });

  test('/backlog (interview dashboard) has no critical a11y violations', async ({
    page,
    loginAsPersona,
  }) => {
    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await loginAsPersona('ba');
    await page.goto('/backlog', { waitUntil: 'domcontentloaded' });
    await expect(mainNav(page)).toBeVisible();
    await assertNoSeriousViolations(page, '/backlog (Interview Dashboard)');
  });

  test('/backlog/prd/:id has no critical a11y violations', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'A11y Audit PRD',
      status: 'pending_review',
      reviewerId: PERSONA_OIDS.qa,
    });

    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await loginAsPersona('ba');
    await page.goto(`/backlog/prd/${prd.id}`, { waitUntil: 'domcontentloaded' });
    await expect(mainNav(page)).toBeVisible();
    // Wait for the PRD content itself so axe scans a fully-rendered page.
    await expect(page.getByRole('heading', { name: /a11y audit prd/i })).toBeVisible();
    await assertNoSeriousViolations(page, '/backlog/prd/:id (PRD Review)');
  });

  test('/calendar has no critical a11y violations', async ({ page, loginAsPersona }) => {
    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await stubAdoWorkItems(page);
    await loginAsPersona('developer');
    await page.goto('/calendar', { waitUntil: 'domcontentloaded' });
    await expect(mainNav(page)).toBeVisible();
    // The react-big-calendar grid renders once work items resolve.
    await expect(page.locator('.rbc-calendar')).toBeVisible();
    await assertNoSeriousViolations(page, '/calendar');
  });

  test('/notifications has no critical a11y violations', async ({ page, loginAsPersona }) => {
    await suppressSseStreams(page);
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/notifications', { waitUntil: 'domcontentloaded' });
    await expect(mainNav(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
    await assertNoSeriousViolations(page, '/notifications (Preferences)');
  });
});

function isLoopbackPortReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function stubHarnessHomeThread(
  page: Page,
  threadId: string,
  status: 'idle' | 'running',
  runId: string | null,
): Promise<void> {
  await suppressSseStreams(page);
  await suppressBetaAnnouncement(page);
  await stubAdoProjects(page);
  await page.addInitScript((project: string) => {
    window.localStorage.setItem('selectedProject', project);
    window.localStorage.setItem('selectedAreaPath', project);
  }, E2E_PROJECT);

  await page.route(`**/api/chat/threads/${threadId}`, async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: threadId,
        userId: PERSONA_OIDS.developer,
        kickoff: {
          project: E2E_PROJECT,
          repo: 'AI-Pilot',
          branch: 'main',
          model: 'auto',
        },
        messages: [],
        status,
        activeRunId: runId,
        workspaceDir: `/tmp/${threadId}`,
        flagged: false,
        createdAt: '2026-11-19T11:00:00.000Z',
        lastActivityAt: '2026-11-19T11:00:00.000Z',
      }),
    });
  });
}

test.describe('Chat harness accessibility (VT-53)', { tag: '@a11y' }, () => {
  test('VT-53: live work box, thought process drawer, connection banner, and running composer pass axe with polite live regions', async ({
    page,
    loginAsPersona,
  }) => {
    const ipv4Ready = await isLoopbackPortReachable('127.0.0.1', 3000);
    // DEFERRED: Playwright env unavailable — skip cleanly when no local E2E server is listening on 127.0.0.1:3000.
    test.skip(!ipv4Ready, '// DEFERRED: Playwright env unavailable');
    test.skip(
      typeof page.routeWebSocket !== 'function',
      '// DEFERRED: Playwright env unavailable',
    );

    const threadId = '44444444-4444-4444-8444-444444444401';
    const runId = '50000000-0000-4000-8000-000000000053';
    const runningState: HarnessThreadState = {
      threadStatus: 'running',
      activeRunId: runId,
      phase: 'running',
      harnessArea: 'agent-home',
      pendingCommands: [],
      latestSummary: null,
      canWrite: true,
    };

    await stubHarnessHomeThread(page, threadId, 'running', runId);

    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'a11y-msg-user-1',
              role: 'user',
              text: 'Audit accessibility across the active harness components.',
              ts: '2026-11-19T11:00:01.000Z',
            },
            {
              id: 'a11y-msg-agent-1',
              role: 'agent',
              text: 'Baseline accessibility audit complete.',
              ts: '2026-11-19T11:00:03.000Z',
              activity: [
                {
                  id: 'a11y-think-saved',
                  kind: 'thinking',
                  text: 'Verified landmark roles and heading hierarchy',
                },
                {
                  id: 'a11y-tool-saved',
                  kind: 'tool',
                  toolName: 'read_file',
                  status: 'completed',
                  target: 'AgentHarnessPanel.tsx',
                },
              ],
            },
          ],
          state: runningState,
          latestSummary: null,
          canWrite: true,
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot),
        });
      },
    );

    const firstWsRef: { current: WebSocketRoute | null } = { current: null };
    let wsAttempts = 0;

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        wsAttempts += 1;
        if (wsAttempts === 1) {
          firstWsRef.current = ws;
        }
        ws.send(JSON.stringify({ type: 'state', state: runningState }));
        ws.send(
          JSON.stringify({
            type: 'event',
            id: `evt-a11y-think-${wsAttempts}`,
            data: {
              type: 'thinking',
              seq: wsAttempts,
              text: 'Checking contrast and ARIA live regions',
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'event',
            id: `evt-a11y-tool-${wsAttempts}`,
            data: {
              type: 'tool_status',
              callId: 'call-a11y-1',
              toolName: 'read_file',
              status: 'running',
              args: { target: 'AgentComposer.tsx' },
            },
          }),
        );
        ws.send(
          JSON.stringify({
            type: 'receipt',
            receipt: {
              commandId: '66666666-6666-4666-8666-666666666601',
              kind: 'steer',
              status: 'applied',
              runId,
              updatedAt: '2026-11-19T11:00:05.000Z',
            } satisfies HarnessReceipt,
          }),
        );
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByTestId('chat-agent-harness-panel')).toBeVisible({
      timeout: 15_000,
    });

    // Live work box polite live region.
    const liveWorkRoot = page.getByTestId('chat-agent-streaming');
    await expect(liveWorkRoot).toBeVisible({ timeout: 10_000 });
    await expect(liveWorkRoot).toHaveAttribute('aria-live', 'polite');

    // Composer receipt polite status region.
    const receipt = page.getByTestId('chat-agent-composer-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt).toHaveAttribute('role', 'status');
    await expect(receipt).toHaveAttribute('aria-live', 'polite');

    // Expand thought process drawer and audit.
    const drawer = page.getByTestId('chat-agent-thought-process');
    await expect(drawer).toBeVisible();
    await page.getByTestId('chat-agent-thought-process-toggle').click();
    await expect(drawer).toHaveAttribute('open', '');

    await assertNoSeriousViolations(
      page,
      'Chat harness — live work box, thought process drawer, and running composer (VT-53)',
    );

    // Drop WS to verify connection banner status/polite live regions and axe compliance.
    expect(firstWsRef.current).not.toBeNull();
    firstWsRef.current?.close();

    const banner = page.getByTestId('chat-agent-connection-banner');
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(banner).toHaveAttribute('aria-live', 'polite');
    await assertNoSeriousViolations(
      page,
      'Chat harness — reconnecting/restored connection banner (VT-53)',
    );
  });

  test('VT-53: failure row, read-only composer, summary notice, and signed-out alert pass axe with expected roles', async ({
    page,
    loginAsPersona,
  }) => {
    const ipv4Ready = await isLoopbackPortReachable('127.0.0.1', 3000);
    // DEFERRED: Playwright env unavailable — skip cleanly when no local E2E server is listening on 127.0.0.1:3000.
    test.skip(!ipv4Ready, '// DEFERRED: Playwright env unavailable');
    test.skip(
      typeof page.routeWebSocket !== 'function',
      '// DEFERRED: Playwright env unavailable',
    );

    const threadId = '44444444-4444-4444-8444-444444444402';
    const runId = '50000000-0000-4000-8000-000000000054';
    const idleReadOnlyState: HarnessThreadState = {
      threadStatus: 'idle',
      activeRunId: null,
      phase: 'idle',
      harnessArea: 'agent-home',
      pendingCommands: [],
      latestSummary: {
        id: 'a11y-summary-1',
        source: 'user',
        fallback: true,
        createdAt: '2026-11-19T11:05:00.000Z',
      },
      canWrite: false,
    };

    await stubHarnessHomeThread(page, threadId, 'idle', null);

    let expireSession = false;
    await page.route(
      `**/api/harness/threads/${threadId}/snapshot`,
      async (route) => {
        if (expireSession) {
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Authentication required' }),
          });
          return;
        }
        const snapshot: HarnessThreadSnapshot = {
          messages: [
            {
              id: 'a11y-fail-user-1',
              role: 'user',
              text: 'Generate quarterly accessibility scorecard.',
              ts: '2026-11-19T11:05:01.000Z',
            },
          ],
          state: idleReadOnlyState,
          latestSummary: idleReadOnlyState.latestSummary,
          canWrite: false,
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(snapshot),
        });
      },
    );

    const firstWsRef: { current: WebSocketRoute | null } = { current: null };
    let wsAttempts = 0;

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws: WebSocketRoute) => {
        wsAttempts += 1;
        if (wsAttempts === 1) {
          firstWsRef.current = ws;
          ws.send(JSON.stringify({ type: 'state', state: idleReadOnlyState }));
          ws.send(
            JSON.stringify({
              type: 'event',
              id: 'evt-a11y-error',
              data: {
                type: 'error',
                runId,
                error: 'Model request timed out.',
              },
            }),
          );
          return;
        }
        // Withhold state frame on reconnect so stateFrameTimeout refreshes snapshot and gets 401.
      },
    );

    await loginAsPersona('developer');
    await page.goto(`/home?thread=${threadId}`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(page.getByTestId('chat-agent-harness-panel')).toBeVisible({
      timeout: 15_000,
    });

    // Failure row carries role="alert".
    const failureRow = page.getByTestId('chat-agent-message-failure');
    await expect(failureRow).toBeVisible({ timeout: 10_000 });
    await expect(failureRow).toHaveAttribute('role', 'alert');

    // Summary notice carries role="status" and aria-live="polite".
    const summaryNotice = page.getByTestId('chat-agent-summary-notice');
    await expect(summaryNotice).toBeVisible();
    await expect(summaryNotice).toHaveAttribute('role', 'status');
    await expect(summaryNotice).toHaveAttribute('aria-live', 'polite');

    // Read-only composer notice carries role="status".
    const readOnlyNotice = page.getByTestId('chat-agent-readonly-notice');
    await expect(readOnlyNotice).toBeVisible();
    await expect(readOnlyNotice).toHaveAttribute('role', 'status');

    await assertNoSeriousViolations(
      page,
      'Chat harness — failure row, summary notice, and read-only composer (VT-53)',
    );

    // Trigger signed-out state (401 snapshot) and confirm role="alert" banner passes axe.
    expireSession = true;
    firstWsRef.current?.close();

    const signedOutBanner = page.getByTestId('chat-agent-connection-banner');
    await expect(signedOutBanner).toBeVisible({ timeout: 10_000 });
    await expect(signedOutBanner).toHaveAttribute('role', 'alert');
    await assertNoSeriousViolations(
      page,
      'Chat harness — signed-out alert banner (VT-53)',
    );
  });
});
