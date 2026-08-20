import { test, expect } from '../support/fixtures';
import { stubAdoProjects, suppressBetaAnnouncement } from '../support/api-stubs';
import type { EvaluateFlagsResponse } from '../../../src/shared/types/featureFlags';

async function stubRfpIntakeFlag(page: import('@playwright/test').Page, enabled: boolean): Promise<void> {
  await page.route('**/api/feature-flags/evaluate*', async (route) => {
    try {
      const response = await route.fetch();
      const data = (await response.json()) as EvaluateFlagsResponse;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ flags: { ...(data?.flags ?? {}), 'rfp-intake': enabled, 'beta-to-prod-announcement': false } }),
      });
    } catch {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ flags: { 'rfp-intake': enabled, 'beta-to-prod-announcement': false } }),
      });
    }
  });
}

test.describe('RFP intake landing VT-05 VT-10', () => {
  test('VT-10 TBI-003 flag off hides Request a Product and Your requests', async ({ page, loginAsPersona }) => {
    test.setTimeout(120_000);
    await suppressBetaAnnouncement(page);
    await stubRfpIntakeFlag(page, false);
    await stubAdoProjects(page);
    await loginAsPersona('ba');
    await page.goto('/');

    await expect(page.getByText(/select a project to start planning/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('rfp-request-product-card')).toHaveCount(0);
    await expect(page.getByTestId('rfp-your-requests-list')).toHaveCount(0);
  });

  test('VT-05 PBI-003/PBI-004 flag on submits and opens owned detail', async ({ page, loginAsPersona }) => {
    test.setTimeout(120_000);
    await suppressBetaAnnouncement(page);
    await stubRfpIntakeFlag(page, true);
    await stubAdoProjects(page);

    const created = {
      id: 'rfp-e2e-1',
      ownerId: 'user-1',
      title: 'E2E intake tracker',
      stakeholder: 'BA',
      request: 'Need a tracker',
      problem: 'Fragmented intake',
      audience: 'internal',
      dataSensitivity: 'internal-only',
      existingSolution: 'none',
      status: 'evaluating',
      aiStatus: 'evaluating',
      clarificationUsed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await page.route('**/api/rfp-intake/requests/mine**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [{ id: created.id, title: created.title, status: 'evaluating', aiStatus: 'evaluating', currentVerdict: null, clarificationUsed: false, createdAt: created.createdAt, updatedAt: created.updatedAt }],
          total: 1,
        }),
      });
    });
    await page.route('**/api/rfp-intake/requests', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
        return;
      }
      await route.continue();
    });
    await page.route('**/api/rfp-intake/requests/rfp-e2e-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...created,
          comments: [],
          attachments: [],
          activity: [{ id: 'evt-1', rfpRequestId: created.id, eventType: 'submitted', actorId: 'user-1', payload: null, createdAt: created.createdAt }],
        }),
      });
    });

    await loginAsPersona('ba');
    await page.goto('/');

    await expect(page.getByTestId('rfp-request-product-card')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('rfp-request-product-card').click();
    await expect(page.getByTestId('rfp-submission-modal')).toBeVisible();

    await page.getByTestId('rfp-field-title').fill('E2E intake tracker');
    await page.getByTestId('rfp-field-stakeholder').fill('BA');
    await page.getByTestId('rfp-field-request').fill('Need a tracker');
    await page.getByTestId('rfp-field-problem').fill('Fragmented intake');
    await page.getByTestId('rfp-field-existingSolution').fill('none');
    await page.getByTestId('rfp-submit-button').click();

    await expect(page.getByTestId('rfp-your-requests-list')).toBeVisible();
    await expect(page.getByTestId('rfp-request-row-rfp-e2e-1')).toContainText(/evaluating/i);
    await page.getByTestId('rfp-request-row-rfp-e2e-1').click();
    await expect(page.getByTestId('rfp-detail-drawer')).toBeVisible();
    await expect(page.getByTestId('rfp-activity-list')).toBeVisible();
  });
});
