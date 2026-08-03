/**
 * PBI-001 / VT-09 — real deployed Cursor SDK primary-chat smoke.
 *
 * Preconditions:
 * - E2E_BASE_URL targets an authenticated deployment running @cursor/sdk 1.0.24.
 * - E2E_TEST_USER + E2E_TEST_PASSWORD (or E2E_STORAGE_STATE) provide auth.
 * - E2E_CURSOR_GROUNDING_PROFILE declares how that deployment is configured:
 *   "local" for a materialized checkout, or "remote" for repository MCP fallback.
 *
 * Run this spec once against each deployed profile. It intentionally uses no
 * route stubs: the assertion requires a real streamed repository read.
 */
import { test, expect } from '../support/fixtures';

const deployedEnvReady = Boolean(
  process.env.E2E_BASE_URL
  && (
    (process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD)
    || process.env.E2E_STORAGE_STATE
  ),
);

for (const profile of ['local', 'remote'] as const) {
  test(
    `PBI-001 AC-0 / AC-2 / VT-09 real Ask Apex stream completes with ${profile} grounding @deployed-smoke`,
    async ({ page, loginAsPersona }) => {
      // DEFERRED: Playwright env unavailable — run once per deployed profile
      // with the documented auth, base URL, and E2E_CURSOR_GROUNDING_PROFILE.
      test.skip(
        !deployedEnvReady || process.env.E2E_CURSOR_GROUNDING_PROFILE !== profile,
        '// DEFERRED: Playwright env unavailable',
      );

      // Given an authenticated deployment configured for the expected profile.
      await loginAsPersona('qa');
      await page.goto('/home');
      await page.getByTestId('apex-fab-trigger').click();
      await page.getByTestId('apex-fab-ask-apex').click();
      const dialog = page.getByRole('dialog', { name: 'Ask Apex Chat' });
      await expect(dialog).toBeVisible();

      // When Ask Apex performs a real repository read and streams its answer.
      const input = dialog.getByPlaceholder('Ask a question...');
      await input.fill(
        'Use the repository MCP to read the root package.json. '
        + 'Reply with only the value of its name field.',
      );
      await dialog.getByRole('button', { name: 'Send message' }).click();

      // Then the real streamed turn completes with grounded content and no error.
      await expect(input).toBeDisabled();
      await expect(dialog.getByText('scrum-calendar', { exact: true })).toBeVisible({
        timeout: 120_000,
      });
      await expect(input).toBeEnabled({ timeout: 120_000 });
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    },
  );
}
