/**
 * FEAT-002 / PBI-004 — Remove Personal Avatar (e2e)
 *
 * AvatarEditor is an isolated component (Wave 3); composition into /profile
 * and the header/menu trigger is owned by FEAT-003/004/005. These specs
 * encode the AC contracts and data-testid selectors from the design spec so
 * a later Feature can unskip them once that composition ships.
 *
 * // DEFERRED: Playwright env / /profile composition not yet shipped (FEAT-003); cross-surface menu assertions belong to FEAT-004/005
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('Remove personal avatar @profile @feat-002', () => {
  // DEFERRED: Playwright env / /profile composition not yet shipped (FEAT-003); cross-surface menu assertions belong to FEAT-004/005
  test.skip('TC-PBI-004-001 / AC-0: confirms removal and sees the fallback avatar', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/profile');

    const editor = page.getByTestId('avatar-editor');
    await expect(editor).toBeVisible();
    // Precondition: an uploaded avatar is active, so Remove is offered (PBI-004 AC-2).
    await expect(editor.getByTestId('avatar-remove-open')).toBeVisible();

    await editor.getByTestId('avatar-remove-open').click();
    const dialog = page.getByTestId('avatar-remove-dialog');
    await expect(dialog).toBeVisible();

    await dialog.getByTestId('avatar-remove-confirm').click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('avatar-operation-status')).toHaveText(/removed/i);
    // Uploaded avatar cleared — Remove is no longer offered; Graph/initials fallback shows.
    await expect(editor.getByTestId('avatar-remove-open')).toHaveCount(0);
  });

  // DEFERRED: Playwright env / /profile composition not yet shipped (FEAT-003); cross-surface menu assertions belong to FEAT-004/005
  test.skip('TC-PBI-004-002 / AC-1: removal failure keeps the dialog open with an honest error', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.route('**/api/profile/avatar', (route) => {
      if (route.request().method() === 'DELETE') {
        return route.fulfill({ status: 503, json: { error: 'Failed to delete avatar' } });
      }
      return route.continue();
    });
    await page.goto('/profile');

    await page.getByTestId('avatar-remove-open').click();
    const dialog = page.getByTestId('avatar-remove-dialog');
    await dialog.getByTestId('avatar-remove-confirm').click();

    await expect(dialog).toBeVisible();
    const status = page.getByTestId('avatar-operation-status');
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).toHaveText(/failed/i);
  });

  // DEFERRED: Playwright env / /profile composition not yet shipped (FEAT-003); cross-surface menu assertions belong to FEAT-004/005
  test.skip('TC-PBI-004-003 / AC-2: Remove is absent or disabled with no uploaded avatar', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/profile');

    const editor = page.getByTestId('avatar-editor');
    await expect(editor).toBeVisible();
    // Precondition: only Graph photo or initials fallback is active (no uploaded avatar).
    await expect(editor.getByTestId('avatar-remove-open')).toHaveCount(0);
    // Fallback avatar remains visible either way.
    const hasImage = await editor.getByTestId('avatar-preview-image').count();
    const hasInitials = await editor.getByTestId('avatar-preview-initials').count();
    expect(hasImage + hasInitials).toBeGreaterThan(0);
  });
});
