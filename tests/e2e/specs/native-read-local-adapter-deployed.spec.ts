/**
 * PBI-005 / VT-13 / VT-14 — deployed native-local adapter smoke.
 *
 * Preconditions:
 * - E2E_BASE_URL targets an authenticated deployment.
 * - E2E_TEST_USER + E2E_TEST_PASSWORD (or E2E_STORAGE_STATE) provide auth.
 * - E2E_NATIVE_READ_STATE declares either "enabled-proven-materialized" or
 *   "disabled".
 * - Playwright can query correlated deployed server-side MCP request logs and
 *   Application Insights events for the Ask Apex turn.
 *
 * The final prerequisite is not currently exposed to Playwright. Keep these
 * tests deferred until that observability exists; their bodies deliberately
 * fail after the UI assertions so removing the skip cannot produce a false pass.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';

const deployedEnvReady = Boolean(
  process.env.E2E_BASE_URL
  && (
    (process.env.E2E_TEST_USER && process.env.E2E_TEST_PASSWORD)
    || process.env.E2E_STORAGE_STATE
  ),
);

const deployedServerObservabilityExposed = false;
const repositoryQuestion =
  'Read the root package.json from the configured repository. '
  + 'Reply with only the value of its name field.';

async function askRepositoryQuestion(
  page: Page,
): Promise<void> {
  await page.goto('/home');
  await page.getByTestId('apex-fab-trigger').click();
  await page.getByTestId('apex-fab-ask-apex').click();
  const dialog = page.getByRole('dialog', { name: 'Ask Apex Chat' });
  await expect(dialog).toBeVisible();

  const input = dialog.getByPlaceholder('Ask a question...');
  await input.fill(repositoryQuestion);
  await dialog.getByRole('button', { name: 'Send message' }).click();

  await expect(input).toBeDisabled();
  await expect(dialog.getByText('scrum-calendar', { exact: true })).toBeVisible({
    timeout: 120_000,
  });
  await expect(input).toBeEnabled({ timeout: 120_000 });
  await expect(dialog.getByRole('alert')).toHaveCount(0);
}

test(
  'PBI-005 AC-0 / VT-13 reads the configured checkout natively without provider browse @deployed-smoke',
  async ({ page, loginAsPersona }) => {
    // DEFERRED: Playwright env unavailable
    test.skip(
      !deployedEnvReady
      || process.env.E2E_NATIVE_READ_STATE !== 'enabled-proven-materialized'
      || !deployedServerObservabilityExposed,
      'DEFERRED: deployed server-side MCP request-log and Application Insights observability is not exposed to Playwright',
    );

    await loginAsPersona('qa');
    await askRepositoryQuestion(page);

    // VT-13 must query telemetry correlated to this turn and assert exactly one
    // native-read.engaged event. It must also query the MCP request log and
    // assert no ADO/GitHub get_skill_file, list_repo_dir, or search_repo_code
    // tools/call occurred. Browser network events cannot prove either condition.
    throw new Error(
      'VT-13 requires correlated deployed MCP request-log and Application Insights assertions',
    );
  },
);

test(
  'PBI-005 AC-1 / AC-2 / VT-14 falls back to provider MCP with sanitized telemetry @deployed-smoke',
  async ({ page, loginAsPersona }) => {
    // DEFERRED: Playwright env unavailable
    test.skip(
      !deployedEnvReady
      || process.env.E2E_NATIVE_READ_STATE !== 'disabled'
      || !deployedServerObservabilityExposed,
      'DEFERRED: deployed server-side MCP request-log and Application Insights observability is not exposed to Playwright',
    );

    await loginAsPersona('qa');
    await askRepositoryQuestion(page);

    // VT-14 must query the MCP request log correlated to this turn and assert
    // at least one configured-provider repository-browse tools/call. It must
    // also assert a sanitized grounding.fallback event and no
    // native-read.engaged event; sensitive content, paths, and tool arguments
    // must be absent from the telemetry properties.
    throw new Error(
      'VT-14 requires correlated deployed MCP request-log and Application Insights assertions',
    );
  },
);
