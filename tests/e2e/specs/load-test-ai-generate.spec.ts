/**
 * FEAT-011 / PBI-014 — AI-generate a k6 script and thresholds E2E
 * TC-PBI-014-001, TC-PBI-014-003, TC-PBI-014-004
 *
 * AI generate lives on the Raw script tab so the applied script is visible
 * in the editor without switching modes.
 *
 * // DEFERRED: Playwright env unavailable in this local Feature Executor run —
 * // spec is authored and syntactically valid; execution deferred.
 */
import { test, expect } from '../support/fixtures';

test.describe('Load test AI generate @load-test-ai-generate', () => {
  test.skip('TC-PBI-014-001 / AC-0: generate streams script + thresholds into the raw editor, editable before save', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await loginAsPersona('admin');
    await page.goto('/load-tests/new', { waitUntil: 'domcontentloaded' });

    await page.getByTestId('load-test-mode-raw').click();
    await expect(page.getByTestId('load-test-ai-panel')).toBeVisible();
    await expect(page.getByTestId('load-test-raw-editor')).toBeVisible();
    await expect(page.getByTestId('load-test-ai-generate-btn')).toBeDisabled();

    await page.getByTestId('load-test-ai-flow-hints').fill('GET /health then GET /api/items');
    await expect(page.getByTestId('load-test-ai-generate-btn')).toBeEnabled();
    await page.getByTestId('load-test-ai-generate-btn').click();

    await expect(page.getByTestId('load-test-ai-stream-preview')).toBeVisible();
    await expect(page.getByTestId('load-test-ai-applied')).toBeVisible({ timeout: 30_000 });

    // Applied result is visible in the raw editor on the same tab — no mode hop.
    await expect(page.getByTestId('load-test-raw-editor')).not.toBeEmpty();

    // No auto-save/auto-enqueue: Save is still required and enabled.
    await expect(page.getByTestId('load-test-save-btn')).toBeEnabled();
  });

  test.skip('TC-PBI-014-003 / AC-2: no connected repo shows unavailable state with guidance on Raw tab', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await loginAsPersona('admin');
    await page.goto('/load-tests/new', { waitUntil: 'domcontentloaded' });

    await page.getByTestId('load-test-mode-raw').click();

    await expect(page.getByTestId('load-test-ai-unavailable')).toBeVisible();
    await expect(page.getByTestId('load-test-ai-unavailable')).toContainText(
      /guided form|raw script editor/i,
    );
    await expect(page.getByTestId('load-test-ai-generate-btn')).toHaveCount(0);
    // Raw editor remains available for hand authoring.
    await expect(page.getByTestId('load-test-raw-editor')).toBeVisible();
  });

  test.skip('TC-PBI-014-004 / BR-010: regenerating over a raw-edited script requires confirmation', async ({
    page,
    loginAsPersona,
  }) => {
    // DEFERRED: Playwright env unavailable
    await loginAsPersona('admin');
    await page.goto('/load-tests/existing-raw-fixture', { waitUntil: 'domcontentloaded' });

    // Existing definition has scriptSource 'raw' with hand-edited content — opens on Raw tab.
    await expect(page.getByTestId('load-test-raw-editor')).toBeVisible();
    await page.getByTestId('load-test-ai-flow-hints').fill('GET /health');
    await page.getByTestId('load-test-ai-generate-btn').click();

    await expect(page.getByTestId('load-test-ai-regenerate-confirm')).toBeVisible();

    // Cancelling the confirm dialog does not start generation or touch the script.
    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByTestId('load-test-ai-regenerate-confirm')).toHaveCount(0);
    await expect(page.getByTestId('load-test-ai-stream-preview')).toHaveCount(0);
  });
});
