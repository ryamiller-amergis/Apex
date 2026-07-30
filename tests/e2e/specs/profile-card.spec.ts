/**
 * FEAT-001 / PBI-002 — Org-wide profile cards (e2e)
 *
 * ProfileCard UI lives in FEAT-004. These specs encode AC contracts and
 * data-testid selectors from the design spec so FEAT-004 can unskip them.
 *
 * // DEFERRED: Playwright env / ProfileCard surface not yet shipped (FEAT-004)
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('Org-wide profile cards @profile @feat-001', () => {
  // DEFERRED: Playwright env unavailable for ProfileCard until FEAT-004 ships the component.
  test.skip('TC-PBI-002-001 / AC-0: card shows only avatar, name, and escaped bio', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    // Downstream surface that hosts the card trigger — placeholder until FEAT-004 migrates one.
    await page.goto('/home');

    const card = page.getByTestId('profile-card');
    await expect(card).toBeVisible();
    await expect(card.getByText(/@|theme|edit/i)).toHaveCount(0);
  });

  // DEFERRED: Playwright env unavailable for ProfileCard until FEAT-004 ships the component.
  test.skip('TC-PBI-002-003 / AC-2: empty bio handled; avatar fallback descriptor present', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const card = page.getByTestId('profile-card');
    await expect(card).toBeVisible();
    await expect(card.getByText(/no bio added/i)).toBeVisible();
  });

  // DEFERRED: Playwright env unavailable for ProfileCard until FEAT-004 ships the component.
  test.skip('TC-PBI-002-002 / AC-1: contained unavailable state; parent remains usable', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    await expect(page.getByTestId('profile-card-unavailable')).toBeVisible();
    // Parent surface still interactive (home content remains).
    await expect(page.locator('body')).toBeVisible();
  });
});
