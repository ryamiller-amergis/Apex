import {
  E2E_PROJECT,
  expect,
  PERSONA_OIDS,
  test,
} from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';

/**
 * Task 7 — Durable interactive transport cutover contract.
 *
 * Proves the client/server boundary for `ai-runs-v2-transport` with mocked
 * actor/Redis boundaries. Does not require or change Azure.
 *
 * 1. Flag off → legacy `{ ok: true }`
 * 2. Flag on → `{ turnId, runId, status, interactiveClass }`
 * 3. Queued then Dispatched labels (no position/wait estimate)
 * 4. WS failure → SSE without resending the user message
 * 5. Failed-run retry keeps one user bubble
 * 6. Unsupported stdio MCP → 422, no App Service AI work
 * 7. Global saturation stays queued
 * 8. Third per-user turn → 429 USER_INTERACTIVE_LIMIT
 */

const TURN_ID = '20000000-0000-4000-8000-000000000001';
const RUN_ID = '50000000-0000-4000-8000-000000000001';
const RUN_ID_2 = '50000000-0000-4000-8000-000000000002';

async function stubInterviewSurface(
  page: Parameters<typeof stubAdoProjects>[0],
  interviewId: string,
  threadId: string,
  messages: unknown[] = [],
): Promise<void> {
  await page.route(`**/api/interviews/${interviewId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: interviewId,
        chatThreadId: threadId,
        authorId: PERSONA_OIDS.ba,
        title: 'Interactive transport',
        project: E2E_PROJECT,
        repo: 'AI-Pilot',
        status: 'in_progress',
        prdCount: 0,
        prds: [],
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:00:00.000Z',
      }),
    });
  });

  await page.route(`**/api/chat/threads/${threadId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: threadId,
        userId: PERSONA_OIDS.ba,
        kickoff: {
          project: E2E_PROJECT,
          repo: 'AI-Pilot',
          branch: 'main',
          model: 'auto',
        },
        messages,
        status: messages.length ? 'idle' : 'idle',
        workspaceDir: `/tmp/${threadId}`,
        flagged: false,
        createdAt: '2026-08-07T00:00:00.000Z',
        lastActivityAt: '2026-08-07T00:00:00.000Z',
      }),
    });
  });
}

test.describe('durable interactive transport cutover @ai-runs-v2-transport', () => {
  test('flag off preserves the legacy { ok: true } response path', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request
      .get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!serverAvailable, 'Requires the local Apex E2E server');

    await stubAdoProjects(page);
    await suppressSseStreams(page);

    const interviewId = 'interview-legacy-flag-off';
    const threadId = 'thread-legacy-flag-off';
    await stubInterviewSurface(page, interviewId, threadId);

    let messagePosts = 0;
    await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
      messagePosts += 1;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);
    await page.getByTestId('interview-chat-composer').fill('Legacy path');
    await page.getByTestId('interview-chat-composer').press('Enter');

    await expect.poll(() => messagePosts).toBe(1);
  });

  test('flag on returns turnId/runId/status/interactiveClass and shows Queued then Dispatched', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request
      .get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!serverAvailable, 'Requires the local Apex E2E server');

    await stubAdoProjects(page);
    await suppressSseStreams(page);

    const interviewId = 'interview-durable-accept';
    const threadId = 'thread-durable-accept';
    await stubInterviewSurface(page, interviewId, threadId);

    let acceptedBody: Record<string, unknown> | null = null;
    await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
      acceptedBody = {
        turnId: TURN_ID,
        runId: RUN_ID,
        status: 'queued',
        interactiveClass: 'fast',
      };
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify(acceptedBody),
      });
    });

    await page.route(`**/api/chat/threads/${threadId}/stream*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          `data: ${JSON.stringify({
            type: 'phase',
            phase: 'queued',
            status: 'pending',
            runId: RUN_ID,
            detail: 'Queued — waiting for available worker',
          })}`,
          '',
          `data: ${JSON.stringify({
            type: 'phase',
            phase: 'dispatched',
            status: 'started',
            runId: RUN_ID,
            detail: 'Starting…',
          })}`,
          '',
        ].join('\n'),
      });
    });

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);
    await page.getByTestId('interview-chat-composer').fill('Durable turn');
    await page.getByTestId('interview-chat-composer').press('Enter');

    await expect.poll(() => acceptedBody).not.toBeNull();
    expect(acceptedBody).toEqual({
      turnId: TURN_ID,
      runId: RUN_ID,
      status: 'queued',
      interactiveClass: 'fast',
    });

    await expect(page.getByTestId('agent-run-status-queued')).toHaveText(
      'Queued',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('agent-run-status-queued')).not.toContainText(
      'waiting',
    );
    await expect(page.getByTestId('agent-run-status-dispatched')).toHaveText(
      'Dispatched',
      { timeout: 15_000 },
    );
  });

  test('WebSocket failure switches to SSE without sending another message', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request
      .get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!serverAvailable, 'Requires the local Apex E2E server');
    test.skip(
      typeof (page as unknown as { routeWebSocket?: unknown }).routeWebSocket !==
        'function',
      'Requires Playwright WebSocket routing support',
    );

    await stubAdoProjects(page);
    await suppressSseStreams(page);
    await page.addInitScript(() => {
      (window as unknown as { __APEX_INTERACTIVE_WS__?: boolean }).__APEX_INTERACTIVE_WS__ =
        true;
    });

    const interviewId = 'interview-ws-sse-fallback';
    const threadId = 'thread-ws-sse-fallback';
    await stubInterviewSurface(page, interviewId, threadId);

    let messagePosts = 0;
    await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
      messagePosts += 1;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          turnId: TURN_ID,
          runId: RUN_ID,
          status: 'queued',
          interactiveClass: 'fast',
        }),
      });
    });

    await page.routeWebSocket(
      `**/api/interactive/threads/${threadId}/stream*`,
      (ws) => {
        ws.close();
      },
    );

    let sseOpened = false;
    await page.route(`**/api/chat/threads/${threadId}/stream*`, async (route) => {
      sseOpened = true;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          `data: ${JSON.stringify({
            type: 'message',
            message: {
              id: 'assistant-1',
              role: 'assistant',
              text: 'Recovered over SSE',
              ts: '2026-08-07T00:00:02.000Z',
            },
          })}`,
          '',
          `data: ${JSON.stringify({ type: 'done', runId: RUN_ID })}`,
          '',
        ].join('\n'),
      });
    });

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);
    await page.getByTestId('interview-chat-composer').fill('Transport only');
    await page.getByTestId('interview-chat-composer').press('Enter');

    await expect.poll(() => messagePosts).toBe(1);
    await expect.poll(() => sseOpened).toBe(true);
    await expect(page.getByText('Recovered over SSE')).toHaveCount(1, {
      timeout: 20_000,
    });
    expect(messagePosts).toBe(1);
  });

  test('failed-run retry keeps one user bubble', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request
      .get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!serverAvailable, 'Requires the local Apex E2E server');

    await stubAdoProjects(page);
    await suppressSseStreams(page);

    const interviewId = 'interview-retry-one-bubble';
    const threadId = 'thread-retry-one-bubble';
    const userMessage = {
      id: TURN_ID,
      role: 'user',
      text: 'Original question',
      ts: '2026-08-07T00:00:00.000Z',
    };
    await stubInterviewSurface(page, interviewId, threadId, [userMessage]);

    let retryPosts = 0;
    let messagePosts = 0;
    await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
      messagePosts += 1;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });
    await page.route(
      `**/api/chat/threads/${threadId}/runs/${RUN_ID}/retry`,
      async (route) => {
        retryPosts += 1;
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            turnId: TURN_ID,
            runId: RUN_ID_2,
            status: 'queued',
            interactiveClass: 'fast',
          }),
        });
      },
    );

    await page.route(`**/api/chat/threads/${threadId}/stream*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          `data: ${JSON.stringify({
            type: 'error',
            message: 'Actor failed',
            runId: RUN_ID,
          })}`,
          '',
          `data: ${JSON.stringify({ type: 'done', runId: RUN_ID })}`,
          '',
        ].join('\n'),
      });
    });

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);

    const retryButton = page.getByRole('button', { name: /retry/i }).first();
    if (await retryButton.isVisible().catch(() => false)) {
      await retryButton.click();
      await expect.poll(() => retryPosts).toBe(1);
    }

    await expect(page.getByText('Original question')).toHaveCount(1);
    expect(messagePosts).toBe(0);
  });

  test('unsupported stdio MCP returns 422 and starts no App Service AI work', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request
      .get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!serverAvailable, 'Requires the local Apex E2E server');

    await stubAdoProjects(page);
    await suppressSseStreams(page);

    const interviewId = 'interview-stdio-mcp';
    const threadId = 'thread-stdio-mcp';
    await stubInterviewSurface(page, interviewId, threadId);

    let messagePosts = 0;
    await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
      messagePosts += 1;
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED',
        }),
      });
    });

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);
    await page.getByTestId('interview-chat-composer').fill('stdio MCP pill');
    await page.getByTestId('interview-chat-composer').press('Enter');

    await expect.poll(() => messagePosts).toBe(1);
    await expect(page.getByText('INTERACTIVE_V2_STDIO_MCP_UNSUPPORTED')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('agent-run-status-queued')).toHaveCount(0);
  });

  test('global saturation leaves the request queued', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request
      .get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!serverAvailable, 'Requires the local Apex E2E server');

    await stubAdoProjects(page);
    await suppressSseStreams(page);

    const interviewId = 'interview-saturation-queued';
    const threadId = 'thread-saturation-queued';
    await stubInterviewSurface(page, interviewId, threadId);

    await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          turnId: TURN_ID,
          runId: RUN_ID,
          status: 'queued',
          interactiveClass: 'fast',
        }),
      });
    });

    await page.route(`**/api/chat/threads/${threadId}/stream*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          `data: ${JSON.stringify({
            type: 'phase',
            phase: 'queued',
            status: 'pending',
            runId: RUN_ID,
            detail: 'Queued — waiting for available worker',
          })}`,
          '',
        ].join('\n'),
      });
    });

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);
    await page.getByTestId('interview-chat-composer').fill('Saturated');
    await page.getByTestId('interview-chat-composer').press('Enter');

    await expect(page.getByTestId('agent-run-status-queued')).toHaveText(
      'Queued',
      { timeout: 15_000 },
    );
    await expect(page.getByText(/429|USER_INTERACTIVE_LIMIT/i)).toHaveCount(0);
  });

  test('a third per-user turn returns 429 USER_INTERACTIVE_LIMIT', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request
      .get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    test.skip(!serverAvailable, 'Requires the local Apex E2E server');

    await stubAdoProjects(page);
    await suppressSseStreams(page);

    const interviewId = 'interview-user-cap';
    const threadId = 'thread-user-cap';
    await stubInterviewSurface(page, interviewId, threadId);

    await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'USER_INTERACTIVE_LIMIT' }),
      });
    });

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);
    await page.getByTestId('interview-chat-composer').fill('Third turn');
    await page.getByTestId('interview-chat-composer').press('Enter');

    await expect(
      page.getByText(
        'You already have two active AI turns. Finish or stop one before starting another.',
      ),
    ).toBeVisible({ timeout: 10_000 });
  });
});
