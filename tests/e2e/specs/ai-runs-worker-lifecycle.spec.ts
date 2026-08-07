/**
 * FEAT-004 / PBI-004 — fenced background worker lifecycle.
 *
 * // DEFERRED: Playwright env unavailable in this local Feature Executor run —
 * // the browser path also depends on FEAT-005 routing and FEAT-006 status-label wiring.
 * // Lower-tier substitutes: aiRunsWorker.test.ts, aiRunIngestService.test.ts,
 * // agentRunReaperService.test.ts, and pgNotifyService.test.ts.
 */
import { expect, test, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';

test.describe('Fenced AI worker lifecycle @ai-runs-worker', () => {
  test.skip('PBI-004 AC-0 / VT-11: queued through completed remains accessible over the existing stream', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await stubAdoProjects(page);
    await suppressSseStreams(page);

    await page.route('**/api/chat/threads/thread-worker-lifecycle', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'thread-worker-lifecycle',
          userId: 'product-owner',
          kickoff: { project: E2E_PROJECT, repo: 'AI-Pilot' },
          messages: [],
          status: 'running',
          workspaceDir: '/tmp/thread-worker-lifecycle',
          flagged: false,
          createdAt: '2026-08-06T12:00:00.000Z',
          lastActivityAt: '2026-08-06T12:00:00.000Z',
        }),
      });
    });

    await page.route('**/api/chat/threads/thread-worker-lifecycle/stream', async (route) => {
      const events = [
        {
          type: 'phase',
          phase: 'setup',
          status: 'pending',
          detail: 'Queued — waiting for available worker',
          semanticStatus: 'pending',
        },
        {
          type: 'phase',
          phase: 'setup',
          status: 'running',
          detail: 'Starting…',
          semanticStatus: 'running',
        },
        {
          type: 'phase',
          phase: 'implementation',
          status: 'running',
          detail: 'Running',
          semanticStatus: 'running',
        },
        {
          type: 'done',
          runId: 'run-worker-lifecycle',
          semanticPhase: 'completion',
          semanticStatus: 'completed',
        },
      ]
        .map((event, index) => `id: worker-event-${index}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('');

      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        body: events,
      });
    });

    await loginAsPersona('product-owner');
    await page.goto('/home?thread=thread-worker-lifecycle');

    const status = page.getByRole('status', { name: /agent is processing/i });
    await expect(status).toBeVisible();
    await expect(status).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
    await expect(page.getByTestId('chat-run-spinner')).toHaveCount(0);
  });

  test.skip('PBI-004 AC-3 / VT-11: stale fence conflict exposes no terminal completion', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    let terminalCallbacks = 0;
    await page.route('**/api/internal/ai-runs/**/ingest', async (route) => {
      const body = route.request().postDataJSON() as { kind?: string };
      if (body.kind === 'terminal') terminalCallbacks += 1;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'dispatchMessageId does not match this run',
          code: 'AI_RUN_DISPATCH_MISMATCH',
        }),
      });
    });

    await page.goto('/');
    const response = await page.evaluate(async ({ project }) => {
      const result = await fetch(
        `/api/internal/ai-runs/${encodeURIComponent(project)}/run-stale/ingest`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
          dispatchMessageId: 'stale-dispatch',
          kind: 'terminal',
          status: 'completed',
          artifactsFlushed: true,
          }),
        },
      );
      return { status: result.status, body: await result.json() };
    }, { project: E2E_PROJECT });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'AI_RUN_DISPATCH_MISMATCH' });
    expect(terminalCallbacks).toBe(1);
  });
});
