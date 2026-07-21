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
import AxeBuilder from '@axe-core/playwright';
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAdoWorkItems, suppressSseStreams } from '../support/api-stubs';

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
    // Unauthenticated visit renders the Login page.
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
