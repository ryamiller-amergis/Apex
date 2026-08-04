/**
 * PBI-008 — evidence-based manual grounding rollout.
 *
 * Platform Admin browser execution requires a Super Admin Playwright persona.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';

interface RolloutStubOptions {
  eligible: boolean;
}

async function stubPlatformAdmin(
  page: Page,
  { eligible }: RolloutStubOptions,
): Promise<void> {
  await page.route('**/api/platform-admin/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (pathname === '/api/platform-admin/projects') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: [{ id: 'apex', name: 'Apex', description: 'Apex' }],
        }),
      });
      return;
    }
    if (pathname === '/api/platform-admin/assignments') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ assignments: [] }),
      });
      return;
    }
    if (pathname === '/api/platform-admin/menu-settings') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ configs: [] }),
      });
      return;
    }
    if (pathname === '/api/platform-admin/users') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ users: [] }),
      });
      return;
    }
    if (pathname === '/api/platform-admin/groups') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ groups: [] }),
      });
      return;
    }
    if (pathname === '/api/platform-admin/access-requests') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ requests: [] }),
      });
      return;
    }
    if (pathname === '/api/platform-admin/feature-flags') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'grounding-flag',
            key: 'repo-grounding-workspace-profile',
            description: 'Controlled local grounding rollout',
            enabled: true,
            lifecycle: 'active',
            cleanupReady: false,
            createdBy: 'platform-admin',
            createdAt: '2026-08-02T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
            rules: [],
          },
        ]),
      });
      return;
    }
    if (pathname === '/api/platform-admin/grounding/rollout-status') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          cohort: 'design-module',
          sampleSize: 125,
          minimumSampleSize: 100,
          gates: [
            {
              id: 'fallback-rate',
              label: 'Remote fallback rate',
              value: eligible ? 0.01 : 0.03,
              threshold: 0.02,
              comparison: '<',
              status: eligible ? 'pass' : 'fail',
            },
          ],
          eligible,
          blockingGates: eligible ? [] : ['fallback-rate'],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
}

test.describe('PBI-008 grounding rollout status', () => {
  test.skip('AC-0 / BR-011 / VT-09 shows eligible evidence and opens manual controls', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await stubPlatformAdmin(page, { eligible: true });

    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /feature flags/i }).click();

    const scorecard = page.getByTestId('grounding-rollout-status');
    await expect(scorecard).toBeVisible();
    await expect(page.getByTestId('grounding-gate-status')).toContainText(
      'Eligible',
    );
    await expect(page.getByTestId('grounding-gate-row')).toContainText(
      'Remote fallback rate',
    );
    await expect(page.getByTestId('grounding-advance-button')).toBeEnabled();

    await page.getByTestId('grounding-advance-button').click();
    const flagControls = page.locator(
      '#grounding-rollout-feature-flag-controls',
    );
    await expect(flagControls).toBeFocused();
    await expect(
      flagControls.getByRole('button', { name: /hide rules/i }),
    ).toBeVisible();
  });

  test.skip('AC-1 / BR-011 / VT-09 names a breached gate and blocks advancement', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await stubPlatformAdmin(page, { eligible: false });

    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /feature flags/i }).click();

    await expect(page.getByTestId('grounding-gate-status')).toContainText(
      'Blocked',
    );
    await expect(page.getByTestId('grounding-gate-row')).toContainText('Fail');
    await expect(page.getByTestId('grounding-advance-button')).toBeDisabled();
  });
});
