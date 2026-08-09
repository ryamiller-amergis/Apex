import {
  E2E_PROJECT,
  expect,
  PERSONA_OIDS,
  test,
} from '../support/fixtures';
import { stubAdoProjects, suppressSseStreams } from '../support/api-stubs';

test.describe('FEAT-006 background run status @ai-runs-background', () => {
  test('PBI-006 AC-0 / VT-02 announces queued then dispatched through the existing stream', async ({
    page,
    loginAsPersona,
  }) => {
    const serverAvailable = await page.request.get('/health')
      .then((response) => response.ok())
      .catch(() => false);
    // DEFERRED: Playwright env unavailable
    test.skip(!serverAvailable, 'Requires the local Apex E2E server on the configured base URL');

    await stubAdoProjects(page);
    await suppressSseStreams(page);

    const interviewId = 'interview-background-status';
    const threadId = 'thread-background-status';
    await page.route(`**/api/interviews/${interviewId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: interviewId,
          chatThreadId: threadId,
          authorId: PERSONA_OIDS.ba,
          title: 'Background status labels',
          project: E2E_PROJECT,
          repo: 'AI-Pilot',
          status: 'in_progress',
          prdCount: 0,
          prds: [],
          createdAt: '2026-08-06T15:59:00.000Z',
          updatedAt: '2026-08-06T15:59:00.000Z',
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
          messages: [],
          status: 'idle',
          workspaceDir: '/tmp/thread-background-status',
          flagged: false,
          createdAt: '2026-08-06T15:59:00.000Z',
          lastActivityAt: '2026-08-06T15:59:00.000Z',
        }),
      });
    });

    let streamConnections = 0;
    await page.route(
      `**/api/chat/threads/${threadId}/stream*`,
      async (route) => {
        streamConnections += 1;
        const phase = streamConnections === 1
          ? {
              type: 'phase',
              phase: 'queued',
              status: 'pending',
              runId: 'run-background-status',
              eventTimestamp: '2026-08-06T16:00:00.000Z',
            }
          : {
              type: 'phase',
              phase: 'dispatched',
              status: 'running',
              runId: 'run-background-status',
              eventTimestamp: '2026-08-06T16:00:01.000Z',
            };

        await route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
          body: [
            'retry: 100',
            `id: background-status-${streamConnections}`,
            `data: ${JSON.stringify(phase)}`,
            '',
            '',
          ].join('\n'),
        });
      },
    );

    await loginAsPersona('ba');
    await page.goto(`/backlog/interview/${interviewId}`);

    const labelRegion = page.getByTestId('agent-run-status-label');
    const queuedMarker = page.getByTestId('agent-run-status-queued');
    await expect(queuedMarker).toHaveText('Queued — waiting for available worker');
    await expect(labelRegion).toHaveAttribute('role', 'status');
    await expect(labelRegion).toHaveAttribute('aria-live', 'polite');
    await expect(labelRegion).toContainText('Queued — waiting for available worker');

    const dispatchedMarker = page.getByTestId('agent-run-status-dispatched');
    await expect(dispatchedMarker).toHaveText('Starting…', { timeout: 15_000 });
    await expect(labelRegion).toContainText('Starting…');
    await expect(queuedMarker).toHaveCount(0);
  });
});
