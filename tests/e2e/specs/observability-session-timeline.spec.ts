/**
 * FEAT-007 — Interview and Agent Session Timeline (Playwright).
 * Author required; execution deferred when Playwright browsers are unavailable.
 *
 * Lower-tier substitutes:
 *   SessionTimelinePage.test.tsx, useSessionTimeline.test.ts,
 *   observabilitySessionTimeline.test.ts, observabilityQueryRoutes.test.ts
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

async function stubObservabilityUsers(page: Page): Promise<void> {
  await page.route('**/api/platform-admin/users', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ userId: ACTOR, displayName: 'Ada Lovelace', email: 'ada@example.com' }],
      }),
    });
  });
}

const timelineBody = {
  session: { sessionId: SESSION, interviewId: '33333333-3333-4333-8333-333333333333', runIds: ['run-1'] },
  verdict: {
    health: 'progress_timeout',
    label: 'Progress timeout',
    detail: 'The run exceeded the progress abort threshold.',
    hangPointEventId: 'hang-tool',
    assessedAt: '2026-08-17T18:00:00.000Z',
  },
  sourceStatus: { agent: { state: 'complete' }, trace: { state: 'complete' } },
  entries: [
    {
      id: 'agent-1',
      source: 'agent',
      occurredAt: '2026-08-17T17:51:00.000Z',
      title: 'Phase: implementation',
      status: 'completed',
      details: [{ label: 'Phase', value: 'implementation' }],
      runId: 'run-1',
      eventType: 'phase',
      sequence: 1,
    },
    {
      id: 'hang-tool',
      source: 'agent',
      occurredAt: '2026-08-17T17:54:00.000Z',
      title: 'Tool: edit',
      status: 'running',
      details: [{ label: 'Tool', value: 'edit' }],
      runId: 'run-1',
      eventType: 'tool',
      sequence: 4,
      toolName: 'edit',
    },
  ],
  page: { nextCursor: 'cursor-2', returned: 2, loaded: 2, cap: 500, capReached: false },
  partial: false,
};

test.describe('FEAT-007 Interview and Agent Session Timeline', () => {
  test('VT-19 / PBI-006 AC-0 Super Admin opens a populated Session Timeline from Trail', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    test.skip(true, 'DEFERRED: Playwright env unavailable');
    await stubAdoProjects(page);
    await stubObservabilityUsers(page);
    await page.route('**/api/platform-admin/observability/trail**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            id: 'evt-1',
            eventType: 'api_request',
            occurredAt: '2026-08-17T17:30:00.000Z',
            actorId: ACTOR,
            projectId: 'Apex',
            traceId: TRACE,
            sessionId: SESSION,
            routeTemplate: '/api/timecards',
            method: 'POST',
            statusCode: 201,
            durationMs: 142,
            severity: 'info',
            trigger: 'human',
            diagnosticSummary: null,
          }],
          nextCursor: null,
          capReached: false,
        }),
      });
    });
    await page.route(`**/api/platform-admin/observability/sessions/${SESSION}/timeline**`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(timelineBody) });
    });
    await loginAsPersona('super-admin');
    await page.goto('/platform-admin');
    await page.getByTestId('platform-admin-tab-observability').click();
    await page.getByTestId('observability-actor').selectOption(ACTOR);
    await page.getByTestId('observability-apply-filters').click();
    await page.getByTestId(`observability-session-link-${SESSION}`).click();
    await expect(page.getByTestId('session-timeline-page')).toBeVisible();
    await expect(page.getByTestId('session-timeline-verdict')).toContainText('Progress timeout');
    await expect(page.getByTestId('session-timeline-hang-point')).toContainText('Hang point');
    await page.getByTestId('session-timeline-source-agent').click();
    await page.getByTestId('session-timeline-expand-hang-tool').click();
    await expect(page.getByTestId('session-timeline-detail-hang-tool')).toBeVisible();
    await expect(page.getByTestId('session-timeline-load-more')).toBeVisible();
    await expect(page.getByTestId('platform-admin-tab-feature-flags')).toBeVisible();
  });

  test('PBI-006 AC-1 one failed source keeps remaining events and incomplete status', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    test.skip(true, 'DEFERRED: Playwright env unavailable');
    await stubAdoProjects(page);
    await stubObservabilityUsers(page);
    await page.route('**/api/platform-admin/observability/trail**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{
            id: 'evt-1',
            eventType: 'api_request',
            occurredAt: '2026-08-17T17:30:00.000Z',
            actorId: ACTOR,
            projectId: 'Apex',
            traceId: TRACE,
            sessionId: SESSION,
            routeTemplate: '/api/timecards',
            method: 'POST',
            statusCode: 201,
            durationMs: 142,
            severity: 'info',
            trigger: 'human',
            diagnosticSummary: null,
          }],
          nextCursor: null,
          capReached: false,
        }),
      });
    });
    await page.route(`**/api/platform-admin/observability/sessions/${SESSION}/timeline**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...timelineBody,
          partial: true,
          sourceStatus: {
            agent: { state: 'complete' },
            trace: { state: 'failed', message: 'Trace Event overlay source failed.' },
          },
        }),
      });
    });
    await loginAsPersona('super-admin');
    await page.goto('/platform-admin');
    await page.getByTestId('platform-admin-tab-observability').click();
    await page.getByTestId('observability-actor').selectOption(ACTOR);
    await page.getByTestId('observability-apply-filters').click();
    await page.getByTestId(`observability-session-link-${SESSION}`).click();
    await expect(page.getByTestId('session-timeline-partial')).toContainText('Incomplete timeline');
    await expect(page.getByTestId('session-timeline-entry-agent-1')).toBeVisible();
  });

  test('PBI-006 AC-3 unknown session discloses no lifecycle or trace details', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    test.skip(true, 'DEFERRED: Playwright env unavailable');
    await stubAdoProjects(page);
    await stubObservabilityUsers(page);
    await page.route(`**/api/platform-admin/observability/sessions/${SESSION}/timeline**`, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found', code: 'OBSERVABILITY_NOT_FOUND' }),
      });
    });
    await loginAsPersona('super-admin');
    await page.goto('/platform-admin');
    await page.getByTestId('platform-admin-tab-observability').click();
    await page.getByTestId('observability-tab-timeline').click();
    await expect(page.getByTestId('observability-timeline-empty')).toBeVisible();
    await expect(page.getByTestId('session-timeline-list')).toHaveCount(0);
  });
});
