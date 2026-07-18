/**
 * @smoke @critical
 * AC: ado-export
 *
 * Covers the approved-PRD → ADO export entry points at the E2E level.
 *
 * Scope note: the full CreateAdoItemsModal submit flow (selection cascade,
 * success/error panels) requires a fully review-complete PRD — an approved
 * related design doc AND unpushed backlog items (see canCreateAdoItems in
 * PrdReviewView.tsx). That richer seeding is deferred to Tier 1; the modal's
 * internal behaviour is already covered by CreateAdoItemsModal.test.tsx unit
 * tests. See docs/quality/quarantine.md.
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects } from '../support/api-stubs';
import { PrdReviewPage } from '../pages/prd-review.page';

test.describe('ADO export entry points @smoke @critical', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('approved PRD renders with Approved status and downstream generation actions', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'ADO Export Approved',
      status: 'approved',
    });

    await stubAdoProjects(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    // Approved PRD shows its status and the downstream generation actions that
    // precede ADO export.
    await expect(page.getByText('Approved', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('button', { name: /generate design docs/i })
    ).toBeVisible();
  });

  test('draft PRD renders with Draft status', async ({ page, loginAsPersona, e2eApi }) => {
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'ADO Export Draft',
      status: 'draft',
    });

    await stubAdoProjects(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    await expect(page.getByText('Draft', { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  // Deferred to Tier 1 — requires an approved related design doc + unpushed
  // backlog items to enable the "Create in ADO" action. Tracked in
  // docs/quality/quarantine.md (QUARANTINE-E2E-ADO-MODAL).
  test.fixme('full ADO export modal submit (success and error)', async () => {
    // Intentionally deferred: needs richer review-complete PRD seeding.
  });
});
