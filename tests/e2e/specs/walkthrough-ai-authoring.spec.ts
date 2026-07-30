/**
 * FEAT-004 — AI-assisted Walkthrough draft generation and review.
 *
 * Authors the Playwright coverage required by the design-spec testing strategy.
 * Execution is deferred until a Super Admin Playwright persona/env is available.
 */
import { test, expect } from '../support/fixtures';

// DEFERRED: Playwright env unavailable for Super Admin platform-admin journeys in this local run.
test.describe('Platform Admin Walkthrough AI authoring @walkthroughs', () => {
  test.skip('PBI-003/004 — generate, accept/reject, confirm image, recover from redo failure, save', async ({
    page,
  }) => {
    // DEFERRED: Playwright env unavailable
    await page.route('**/api/platform-admin/walkthroughs/ai-drafts/generate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          proposal: {
            proposalId: 'p1',
            walkthroughFields: {
              internalName: 'ai-walkthrough',
              userTitle: 'AI Intro',
              whyItMatters: 'Why it matters',
            },
            steps: [
              {
                id: 's1',
                ordinal: 0,
                heading: 'Accept me',
                bodyMarkdown: 'Accepted body',
                imageUrl: '/favicon.svg',
                imageCandidatePath: '/favicon.svg',
              },
              {
                id: 's2',
                ordinal: 1,
                heading: 'Reject me',
                bodyMarkdown: 'Rejected body',
              },
            ],
            units: [
              {
                unitId: 'walkthrough-fields',
                kind: 'walkthrough-fields',
                value: {
                  internalName: 'ai-walkthrough',
                  userTitle: 'AI Intro',
                  whyItMatters: 'Why it matters',
                },
              },
              {
                unitId: 'step-s1',
                kind: 'step',
                value: {
                  id: 's1',
                  ordinal: 0,
                  heading: 'Accept me',
                  bodyMarkdown: 'Accepted body',
                  imageUrl: '/favicon.svg',
                  imageCandidatePath: '/favicon.svg',
                },
                imageCandidatePath: '/favicon.svg',
              },
              {
                unitId: 'step-s2',
                kind: 'step',
                value: {
                  id: 's2',
                  ordinal: 1,
                  heading: 'Reject me',
                  bodyMarkdown: 'Rejected body',
                },
              },
            ],
            generatedAt: new Date().toISOString(),
            generationContextVersion: 'v1',
            policyPreset: 'A',
          },
        }),
      });
    });

    await page.route('**/api/platform-admin/walkthroughs/ai-drafts/validate-unit', async (route) => {
      const body = route.request().postDataJSON() as {
        unit: { unitId: string; kind: string; value: unknown };
        imageConfirmed: boolean;
      };
      const normalized =
        body.unit.kind === 'step'
          ? {
              ...body.unit,
              value: {
                ...(body.unit.value as object),
                imageUrl: body.imageConfirmed ? '/favicon.svg' : null,
              },
            }
          : body.unit;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, normalizedUnit: normalized }),
      });
    });

    let redoCalls = 0;
    await page.route('**/api/platform-admin/walkthroughs/ai-drafts/redo', async (route) => {
      redoCalls += 1;
      if (redoCalls === 1) {
        await route.fulfill({
          status: 502,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Step redo failed. The previous proposal remains available.',
            code: 'AI_REDO_FAILED',
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/platform-admin');
    await page.getByRole('tab', { name: /walkthroughs/i }).click();
    await page.getByTestId('walkthrough-create').click();

    await expect(page.getByTestId('walkthrough-ai-draft-panel')).toBeVisible();
    await expect(page.getByTestId('walkthrough-ai-policy-preset')).toHaveValue('A');

    await page.getByTestId('walkthrough-ai-intent').fill('Introduce AI walkthroughs');
    await page.getByTestId('walkthrough-ai-generate').click();
    await expect(page.getByTestId('walkthrough-proposal-review')).toBeVisible();

    await page.getByTestId('walkthrough-proposal-walkthrough-fields-accept').click();
    await page.getByTestId('walkthrough-proposal-step-s1-image-confirm').check();
    await page.getByTestId('walkthrough-proposal-step-s1-accept').click();
    await page.getByTestId('walkthrough-proposal-step-s2-reject').click();

    await page.getByTestId('walkthrough-proposal-step-s1-redo').click();
    await expect(page.getByTestId('walkthrough-ai-status')).toContainText(/redo failed/i);
    await expect(page.getByTestId('walkthrough-proposal-step-s1')).toBeVisible();

    await page.getByTestId('walkthrough-ai-apply-accepted').click();
    await page.getByTestId('walkthrough-project-target').locator('input[type="checkbox"]').first().check();
    await page.getByTestId('walkthrough-save-draft').click();

    await expect(page.getByTestId('walkthrough-catalog')).toBeVisible();
    await expect(page.getByText('ai-walkthrough')).toBeVisible();
    await expect(page.getByText('Reject me')).toHaveCount(0);
  });
});
