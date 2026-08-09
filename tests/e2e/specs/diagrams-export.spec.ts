/**
 * FEAT-004 / PBI-005 VT-07 — Diagram export lifecycle (PNG / SVG / .excalidraw).
 *
 * DEFERRED: Playwright env unavailable in local Feature Executor runs.
 * Lower-tier substitutes:
 * - src/client/components/__tests__/DiagramExportMenu.test.tsx (AC-1 / AC-2 / VT-06)
 * - src/client/components/__tests__/DiagramEditorView.test.tsx (AC-3 wiring)
 * - src/client/components/__tests__/DiagramTitleEditor.test.tsx (AC-0 / AC-3)
 */
import { test, expect } from '../support/fixtures';

test.describe('Diagram rename and export @feat-004', () => {
  // DEFERRED: Playwright env unavailable
  test.skip('VT-07 / PBI-005 AC-2: export PNG, SVG, and .excalidraw downloads', async ({
    page,
  }) => {
    await page.goto('/diagrams');
    await expect(page.getByTestId('diagrams-browse-view')).toBeVisible();

    // Open an existing Diagram (or create one) so the editor canvas is ready.
    const firstCard = page.getByTestId('diagram-card').first();
    if (await firstCard.count()) {
      await firstCard.click();
    } else {
      await page.getByTestId('diagram-new-button').click();
      await page.getByTestId('diagram-save-button').click();
    }

    await expect(page.getByTestId('diagram-editor-canvas')).toBeVisible();

    const pngDownload = page.waitForEvent('download');
    await page.getByTestId('diagram-export-png').click();
    const png = await pngDownload;
    expect(png.suggestedFilename()).toMatch(/\.png$/i);

    const svgDownload = page.waitForEvent('download');
    await page.getByTestId('diagram-export-svg').click();
    const svg = await svgDownload;
    expect(svg.suggestedFilename()).toMatch(/\.svg$/i);

    const nativeDownload = page.waitForEvent('download');
    await page.getByTestId('diagram-export-excalidraw').click();
    const native = await nativeDownload;
    expect(native.suggestedFilename()).toMatch(/\.excalidraw$/i);
  });

  // DEFERRED: Playwright env unavailable
  test.skip('VT-07 / PBI-005 AC-0: rename title + save updates editor title', async ({
    page,
  }) => {
    await page.goto('/diagrams/new');
    await expect(page.getByTestId('diagram-title-input')).toBeVisible();
    await page.getByTestId('diagram-title-input').fill('Lifecycle Export Diagram');
    await page.getByTestId('diagram-save-button').click();
    await expect(page.getByTestId('diagram-title-input')).toHaveValue('Lifecycle Export Diagram');
  });
});
