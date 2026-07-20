/**
 * @smoke
 * AC: interview-dashboard
 *
 * Covers the Interviews dashboard:
 * - BA/PO/Manager personas can start a new interview.
 * - Developer/QA personas cannot (no start button shown).
 * - Dashboard tabs render correctly.
 */
import { test, expect } from '../support/fixtures';
import type { Persona } from '../support/fixtures';
import { stubAdoProjects, suppressBetaAnnouncement } from '../support/api-stubs';
import { InterviewDashboardPage } from '../pages/interview-dashboard.page';
import type { Page } from '@playwright/test';

async function loginAndGotoDashboard(
  page: Page,
  loginAsPersona: (persona: Persona) => Promise<void>,
  persona: Persona,
) {
  // Registered before login so the first flag-evaluate call is intercepted and
  // the blocking beta modal never renders for the non-admin account on dev/staging.
  await suppressBetaAnnouncement(page);
  await stubAdoProjects(page);
  await loginAsPersona(persona);
  // Navigate directly to the backlog route (decoupled from per-project menu
  // configuration and sidebar nav-item visibility).
  const dashboard = new InterviewDashboardPage(page);
  await dashboard.goto();
  return dashboard;
}

test.describe('Interview dashboard @smoke', () => {
  test('dashboard loads with section buttons for BA persona @deployed-smoke', async ({ page, loginAsPersona }) => {
    const dashboard = await loginAndGotoDashboard(page, loginAsPersona, 'ba');

    await expect(page).toHaveURL(/\/backlog/, { timeout: 10_000 });
    // The dashboard renders section selector buttons: Interviews (N), PRDs (N), …
    await expect(dashboard.tabButton('Interviews')).toBeVisible();
    await expect(dashboard.tabButton('PRDs')).toBeVisible();
  });

  test('BA persona can start an interview (button enabled)', async ({ page, loginAsPersona }) => {
    const dashboard = await loginAndGotoDashboard(page, loginAsPersona, 'ba');
    await expect(dashboard.startInterviewButton()).toBeEnabled();
  });

  test('Manager persona can start an interview (button enabled)', async ({ page, loginAsPersona }) => {
    const dashboard = await loginAndGotoDashboard(page, loginAsPersona, 'manager');
    await expect(dashboard.startInterviewButton()).toBeEnabled();
  });

  test('Product Owner persona can start an interview (button enabled)', async ({ page, loginAsPersona }) => {
    const dashboard = await loginAndGotoDashboard(page, loginAsPersona, 'product-owner');
    await expect(dashboard.startInterviewButton()).toBeEnabled();
  });

  test('Developer persona cannot start an interview (button disabled)', async ({ page, loginAsPersona }) => {
    const dashboard = await loginAndGotoDashboard(page, loginAsPersona, 'developer');
    // Developer is not in BA/Manager/Product-Owner group → start button disabled.
    await expect(dashboard.startInterviewButton()).toBeDisabled();
  });

  test('QA persona cannot start an interview (button disabled)', async ({ page, loginAsPersona }) => {
    const dashboard = await loginAndGotoDashboard(page, loginAsPersona, 'qa');
    await expect(dashboard.startInterviewButton()).toBeDisabled();
  });

  test('switching to the PRDs section works', async ({ page, loginAsPersona }) => {
    const dashboard = await loginAndGotoDashboard(page, loginAsPersona, 'ba');
    await dashboard.clickTab('PRDs');

    // The PRDs section button remains visible after selection.
    await expect(dashboard.tabButton('PRDs')).toBeVisible({ timeout: 5_000 });
  });
});
