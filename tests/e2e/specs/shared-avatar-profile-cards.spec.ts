/**
 * FEAT-004 / PBI-007 / TC-PBI-007-001 — Shared Avatar consistency across hosts.
 *
 * Production surfaces are intentionally not migrated in this protected delivery
 * (see assumptions). Specs assert the design-spec data-testid contracts so a
 * later integration work item can unskip against a real migrated page.
 *
 * // DEFERRED: Playwright env / no migrated production surface in FEAT-004
 */
import { test, expect } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';

test.describe('Shared Avatar and Profile Cards @profile @feat-004', () => {
  // DEFERRED: Playwright env unavailable — FEAT-004 ships components only;
  // production-surface adoption is a later authorized integration task.
  // Lower-tier substitute: SharedAvatar.twoHost.test.tsx (AC-0 / VT-01).
  test.skip('TC-PBI-007-001 / AC-0: identical uploaded avatar across two migrated surfaces', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await loginAsPersona('developer');
    await page.goto('/home');

    const oid = 'oid-colleague';
    await expect(page.getByTestId(`shared-avatar-${oid}`).first()).toBeVisible();
    await expect(page.getByTestId(`shared-avatar-image-${oid}`).first()).toBeVisible();

    await page.getByTestId(`profile-card-trigger-${oid}`).first().click();
    await expect(page.getByTestId(`profile-card-${oid}`)).toBeVisible();
    await expect(page.getByTestId(`profile-card-close-${oid}`)).toBeVisible();
  });
});
