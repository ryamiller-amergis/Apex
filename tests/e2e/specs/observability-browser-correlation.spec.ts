/**
 * FEAT-003 / PBI-002 — browser correlation and ingest (Playwright).
 * VT-01, VT-04, VT-09. Execution may be deferred when Playwright browsers are unavailable.
 *
 * Lower-tier substitutes: ObservabilityProvider.test.tsx, requestInstrumentation.test.ts,
 * observabilityIngestRoute.test.ts.
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('FEAT-003 browser correlation', () => {
  test('TC-PBI-002-001 / AC-0 correlated route view and API traceparent', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable — keep spec authored and syntactically valid.
    test.skip(true, 'DEFERRED: Playwright env unavailable');
    await stubAdoProjects(page);
    await loginAsPersona('developer');

    const ingestBodies: unknown[] = [];
    await page.route('**/api/observability/events', async (route) => {
      ingestBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ accepted: 1 }) });
    });

    await page.goto('/home');
    await page.goto('/calendar');
    await page.waitForTimeout(5500);
    expect(ingestBodies.length).toBeGreaterThan(0);
  });

  test('TC-PBI-002-002 / AC-1 pagehide flush does not block navigation', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    test.skip(true, 'DEFERRED: Playwright env unavailable');
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect(page.locator('body')).toBeVisible();
  });

  test('TC-PBI-002-007 / BR-010 no ingest when capture flag is disabled', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    test.skip(true, 'DEFERRED: Playwright env unavailable');
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    let ingestCount = 0;
    await page.route('**/api/observability/events', async (route) => {
      ingestCount += 1;
      await route.fulfill({ status: 404, body: '{}' });
    });
    await page.goto('/home');
    await page.waitForTimeout(5500);
    expect(ingestCount).toBe(0);
  });
});
