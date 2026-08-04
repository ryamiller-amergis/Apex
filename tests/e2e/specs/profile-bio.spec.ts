/**
 * FEAT-001 / PBI-001 — Manage Personal Profile (e2e)
 *
 * Full UI lives in FEAT-003 (/profile page). These specs encode the AC contracts
 * and data-testid selectors from the design spec so FEAT-003 can unskip them.
 *
 * // DEFERRED: Playwright env / /profile page not yet shipped (FEAT-003)
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('Personal profile bio @profile @feat-001', () => {
  // DEFERRED: Playwright env unavailable for /profile until FEAT-003 ships the page shell.
  test.skip('TC-PBI-001-001 / AC-0: saves valid bio; identity remains read-only', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/profile');

    const name = page.getByTestId('profile-identity-name');
    const email = page.getByTestId('profile-identity-email');
    const bio = page.getByTestId('profile-bio-input');
    const save = page.getByTestId('profile-bio-save');

    await expect(name).toBeVisible();
    await expect(email).toBeVisible();
    // Identity fields must not be editable controls.
    await expect(name).not.toHaveAttribute('contenteditable', 'true');

    const priorName = await name.innerText();
    const priorEmail = await email.innerText();

    await bio.fill('Senior developer focused on platform tooling.');
    await save.click();

    await expect(bio).toHaveValue('Senior developer focused on platform tooling.');
    await expect(name).toHaveText(priorName);
    await expect(email).toHaveText(priorEmail);
  });

  // DEFERRED: Playwright env unavailable for /profile until FEAT-003 ships the page shell.
  test.skip('TC-PBI-001-003 / AC-2: empty and 500-character bios persist after reload', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/profile');

    const bio = page.getByTestId('profile-bio-input');
    const save = page.getByTestId('profile-bio-save');
    const count = page.getByTestId('profile-bio-count');

    await bio.fill('');
    await save.click();
    await page.reload();
    await expect(bio).toHaveValue('');

    const boundary = 'a'.repeat(500);
    await bio.fill(boundary);
    await expect(count).toContainText('500');
    await save.click();
    await page.reload();
    await expect(bio).toHaveValue(boundary);
  });
});
