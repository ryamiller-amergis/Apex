import { expect, test, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';

test.describe('FEAT-001 authoritative terminal access', () => {
  test('PBI-001 AC-3 / VT-08 denies another user thread stream without terminal detail', async ({
    page,
    loginAsPersona,
  }) => {
    // Given User B owns a chat thread.
    await loginAsPersona('ba');
    const created = await page.request.post('/api/chat/threads', {
      data: {
        kickoff: {
          project: E2E_PROJECT,
          repo: 'AI-Pilot',
          branch: 'main',
          provider: 'github',
          model: 'auto',
        },
        skipAutoKickoff: true,
      },
    });
    expect(created.status()).toBe(201);
    const { threadId } = await created.json() as { threadId: string };

    // When User A requests User B's replay-capable SSE stream.
    await loginAsPersona('developer');
    const denied = await page.request.get(`/api/chat/threads/${threadId}/stream`, {
      headers: { 'Last-Event-ID': '00000000-0000-4000-8000-000000000001' },
      timeout: 10_000,
    });
    const body = await denied.text();

    // Then access is denied before any persisted terminal detail is disclosed.
    expect([403, 404]).toContain(denied.status());
    expect(body).not.toContain('owner deadline');
    expect(body).not.toContain('terminal');
    expect(body).not.toContain('detail');
  });
});

test.describe('FEAT-002 event-driven replay authority', () => {
  test('PBI-002 AC-0 / VT-08 clears spinner from replay without run-status polling', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await suppressSseStreams(page);
    let streamConnections = 0;
    let runStatusRequests = 0;

    await page.route('**/api/chat/threads/thread-retire/run-status', async (route) => {
      runStatusRequests += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Polling must not occur in Retire mode' }),
      });
    });
    await page.route('**/api/chat/threads/thread-retire/stream', async (route) => {
      streamConnections += 1;
      const status = `data: ${JSON.stringify({
        type: 'status',
        status: 'running',
        eventDrivenTermination: true,
      })}\n\n`;
      const replayedTerminal = [
        `id: terminal-event-1\ndata: ${JSON.stringify({
          type: 'error',
          error: 'Run exceeded configured hard limit',
          runId: 'run-retire',
          eventTimestamp: '2026-08-04T12:00:00.000Z',
          semanticPhase: 'completion',
          semanticStatus: 'failed',
        })}\n\n`,
        `id: terminal-event-2\ndata: ${JSON.stringify({
          type: 'done',
          runId: 'run-retire',
          eventTimestamp: '2026-08-04T12:00:00.001Z',
          semanticPhase: 'completion',
          semanticStatus: 'completed',
        })}\n\n`,
      ].join('');
      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: streamConnections === 1 ? status : `${status}${replayedTerminal}`,
      });
    });
    await page.route('**/api/chat/threads/thread-retire', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'thread-retire',
          userId: 'developer',
          kickoff: { project: E2E_PROJECT, repo: 'AI-Pilot' },
          messages: [],
          status: 'running',
          workspaceDir: '/tmp/thread-retire',
          flagged: false,
          createdAt: '2026-08-04T11:59:00.000Z',
          lastActivityAt: '2026-08-04T12:00:00.000Z',
        }),
      });
    });

    await loginAsPersona('developer');
    await page.goto('/home?thread=thread-retire');

    await expect(page.getByTestId('chat-run-terminal')).toContainText(
      'Run exceeded configured hard limit',
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('chat-run-spinner')).toHaveCount(0);
    expect(streamConnections).toBeGreaterThanOrEqual(2);
    expect(runStatusRequests).toBe(0);
  });
});
