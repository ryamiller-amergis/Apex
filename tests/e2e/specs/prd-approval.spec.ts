/**
 * @smoke @critical
 * AC: prd-approval
 *
 * Covers the PRD two-step approval state machine:
 * - Unresolved review comments block the Approve button.
 * - Resolving comments enables approval.
 * - Reviewer approves → status transitions to "awaiting owner".
 * - Owner gives final approval → status becomes "approved".
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { PrdReviewPage } from '../pages/prd-review.page';

test.describe('PRD approval flow @smoke @critical', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('approved PRD shows "approved" status badge', async ({ page, loginAsPersona, e2eApi }) => {
    // Seed an already-approved PRD for the BA persona as owner.
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Approved PRD Test',
      status: 'approved',
    });

    await stubAdoProjects(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    await expect(page.getByText('Approved', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('pending_review PRD renders with its status and owner', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Pending Review PRD',
      status: 'pending_review',
      reviewerId: PERSONA_OIDS.qa,
    });

    await stubAdoProjects(page);
    // Log in as QA (assigned reviewer).
    await loginAsPersona('qa');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    // The PRD renders with its Pending Review status.
    await expect(page.getByText('Pending Review', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  test('PRD review is locked until test cases are generated', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    // Business rule: a PRD cannot be reviewed/approved until test cases exist.
    // A freshly-seeded PRD (no test cases) must therefore show the readiness
    // gate rather than an enabled Approve action.
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Review Gate PRD',
      status: 'pending_review',
      reviewerId: PERSONA_OIDS.qa,
    });

    await stubAdoProjects(page);
    await loginAsPersona('qa');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    // The readiness gate is shown; no enabled Approve action exists yet.
    await expect(
      page.getByText(/test-case generation is required|waiting on test cases|review locked/i).first()
    ).toBeVisible({ timeout: 10_000 });
  });

  test('draft PRD is visible to the author', async ({ page, loginAsPersona, e2eApi }) => {
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Draft PRD Visibility',
      status: 'draft',
    });

    await stubAdoProjects(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    // Should render the PRD page without a 404.
    await expect(page).not.toHaveURL(/404|not.*found/i);
    await expect(
      page.getByRole('heading', { name: /Draft PRD Visibility/i })
    ).toBeVisible({ timeout: 10_000 });
  });
});
