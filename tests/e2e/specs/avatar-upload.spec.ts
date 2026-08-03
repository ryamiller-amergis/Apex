/**
 * FEAT-002 / PBI-003 — Upload or Replace Personal Avatar (e2e)
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

test.describe('Upload or replace personal avatar @profile @feat-002', () => {
  // DEFERRED: Playwright env / /profile composition not yet shipped (FEAT-003); cross-surface menu assertions belong to FEAT-004/005
  test.skip('TC-PBI-003-001 / AC-0: crops and uploads a valid avatar image', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/profile');

    const editor = page.getByTestId('avatar-editor');
    await expect(editor).toBeVisible();

    await editor.getByTestId('avatar-file-input').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
    });

    const cropDialog = page.getByTestId('avatar-crop-dialog');
    await expect(cropDialog).toBeVisible();
    await expect(cropDialog.getByTestId('avatar-crop-preview')).toBeVisible();

    await cropDialog.getByTestId('avatar-upload-submit').click();

    const status = page.getByTestId('avatar-operation-status');
    await expect(status).toHaveText(/updated/i);
    await expect(cropDialog).toBeHidden();

    // Fresh cache-busting version should propagate across Profile and the menu trigger.
    await expect(page.getByTestId('avatar-preview-image')).toBeVisible();
  });

  // DEFERRED: Playwright env / /profile composition not yet shipped (FEAT-003); cross-surface menu assertions belong to FEAT-004/005
  test.skip('TC-PBI-003-002 / AC-1: upload failure retains the previously resolved avatar', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.route('**/api/profile/avatar', (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 502, json: { error: 'Failed to store avatar' } });
      }
      return route.continue();
    });
    await page.goto('/profile');

    const editor = page.getByTestId('avatar-editor');
    await editor.getByTestId('avatar-file-input').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
      ),
    });
    await page.getByTestId('avatar-upload-submit').click();

    const status = page.getByTestId('avatar-operation-status');
    await expect(status).toHaveAttribute('role', 'alert');
    await expect(status).toHaveText(/failed/i);
  });
});
