/**
 * PBI-004 AC-0 / AC-2 — deployed native-read no-behavior-change smoke.
 *
 * Preconditions:
 * - E2E_BASE_URL targets an authenticated deployment.
 * - E2E_TEST_USER + E2E_TEST_PASSWORD (or E2E_STORAGE_STATE) provide auth.
 * - E2E_NATIVE_READ_STATE declares the deployment state:
 *   "disabled" or "targeted-on-unproven".
 *
 * Run this spec once against each declared state. It intentionally performs no
 * flag mutation and observes only the real streamed MCP repository-read behavior.
 */
import { expect, test } from '../support/fixtures';

const deployedEnvReady = Boolean(
  process.env.E2E_BASE_URL
  && (
    (process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD)
    || process.env.E2E_STORAGE_STATE
  ),
);

for (const state of ['disabled', 'targeted-on-unproven'] as const) {
  test(
    `PBI-004 AC-0 / AC-2 preserves MCP repository reads when native-read is ${state} @deployed-smoke`,
    async ({ page, loginAsPersona }) => {
      // DEFERRED: Playwright env unavailable
      test.skip(
        !deployedEnvReady || process.env.E2E_NATIVE_READ_STATE !== state,
        '// DEFERRED: Playwright env unavailable',
      );

      await loginAsPersona('qa');
      await page.goto('/home');
      await page.getByTestId('apex-fab-trigger').click();
      await page.getByTestId('apex-fab-ask-apex').click();
      const dialog = page.getByRole('dialog', { name: 'Ask Apex Chat' });
      await expect(dialog).toBeVisible();

      const input = dialog.getByPlaceholder('Ask a question...');
      await input.fill(
        'Use the repository MCP to read the root package.json. '
        + 'Reply with only the value of its name field.',
      );
      await dialog.getByRole('button', { name: 'Send message' }).click();

      await expect(input).toBeDisabled();
      await expect(dialog.getByText('scrum-calendar', { exact: true })).toBeVisible({
        timeout: 120_000,
      });
      await expect(input).toBeEnabled({ timeout: 120_000 });
      await expect(dialog.getByRole('alert')).toHaveCount(0);
    },
  );
}
