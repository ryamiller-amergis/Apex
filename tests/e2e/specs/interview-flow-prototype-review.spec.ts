/**
 * @interview-flow @pipeline
 * Prototype review: reviewer/owner approve, request changes, regenerate, comments.
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic, stubPrototypeGeneration } from '../support/api-stubs';
import { PrototypeReviewPage } from '../pages/prototype-review.page';

async function seedPrototypeFixture(
  e2eApi: Parameters<typeof SeedApi.seedPrd>[0],
  status: 'pending_review' | 'reviewer_approved' | 'approved' | 'revision_requested' = 'pending_review',
) {
  await SeedApi.seedProjectSettings(e2eApi, {
    project: E2E_PROJECT,
    friendlyName: 'Proto Pool',
    isDefault: true,
    designPrototypeApprovers: [PERSONA_OIDS.qa],
  });

  const interview = await SeedApi.seedInterview(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'Proto Interview',
    status: 'complete',
    prdOwnerId: PERSONA_OIDS.ba,
    designPrototypeOwnerId: PERSONA_OIDS['ui-ux'],
    designPrototypeApproverIds: [PERSONA_OIDS.qa],
  });

  const prd = await SeedApi.seedPrd(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'Proto Parent PRD',
    status: 'approved',
    interviewId: interview.id,
    withReadyTestCases: true,
  });

  const proto = await SeedApi.seedDesignPrototype(e2eApi, {
    prdId: prd.id,
    authorId: PERSONA_OIDS.ba,
    featureName: 'Proto Feature',
    status,
  });

  // design_prototype assignments are keyed by PRD id (set-level), not prototype id.
  await SeedApi.seedApproverAssignments(e2eApi, {
    documentId: prd.id,
    documentType: 'design_prototype',
    approverUserIds: [PERSONA_OIDS.qa],
    assignedBy: PERSONA_OIDS.ba,
    status: status === 'pending_review' ? 'pending' : 'approved',
  });

  return { interview, prd, proto };
}

test.describe('Interview flow — Prototype review @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('reviewer can approve pending_review prototype', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { prd } = await seedPrototypeFixture(e2eApi, 'pending_review');

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('qa');

    const protoPage = new PrototypeReviewPage(page);
    await protoPage.goto(prd.id);

    await expect(protoPage.root()).toBeVisible({ timeout: 10_000 });
    await expect(protoPage.approveButton()).toBeVisible({ timeout: 10_000 });
    await protoPage.clickApprove();
    // Reviewer approve on a single-prototype set navigates back to the PRD page.
    await expect(page).toHaveURL(new RegExp(`/backlog/prd/${prd.id}`), { timeout: 15_000 });
    // Re-open prototypes to confirm status transition.
    await protoPage.goto(prd.id);
    await expect(
      page.getByText(/awaiting owner approval|reviewer approved|approved/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('reviewer can request changes', async ({ page, loginAsPersona, e2eApi }) => {
    const { prd } = await seedPrototypeFixture(e2eApi, 'pending_review');

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('qa');

    const protoPage = new PrototypeReviewPage(page);
    await protoPage.goto(prd.id);

    await expect(protoPage.requestChangesButton()).toBeVisible({ timeout: 10_000 });
    await protoPage.clickRequestChanges();
    // Request Changes + regenerate: stubbed regen may leave UI on revision_requested
    // or regenerating. Also accept the feature tab badge text.
    await expect(
      page
        .getByText(/revision requested|regenerating/i)
        .or(page.getByRole('button', { name: /revision requested|regenerating/i }))
        .or(protoPage.regenerateButton())
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });

  test('owner approve on reviewer_approved → approved', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { prd } = await seedPrototypeFixture(e2eApi, 'reviewer_approved');

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ui-ux');

    const protoPage = new PrototypeReviewPage(page);
    await protoPage.goto(prd.id);

    await expect(protoPage.approveOwnerButton()).toBeVisible({ timeout: 10_000 });
    await protoPage.clickApproveOwner();
    // Owner approve navigates to the parent PRD page on success.
    await expect(page).toHaveURL(new RegExp(`/backlog/prd/${prd.id}`), { timeout: 15_000 });
    await protoPage.goto(prd.id);
    await expect(protoPage.statusBadge()).toContainText(/approved/i, { timeout: 15_000 });
  });

  test('regenerate button visible on revision_requested (stubbed)', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { prd } = await seedPrototypeFixture(e2eApi, 'revision_requested');

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await stubPrototypeGeneration(page);
    await loginAsPersona('ba');

    const protoPage = new PrototypeReviewPage(page);
    await protoPage.goto(prd.id);

    await expect(protoPage.regenerateButton()).toBeVisible({ timeout: 10_000 });
  });

  test('approved prototype shows approved badge', async ({ page, loginAsPersona, e2eApi }) => {
    const { prd } = await seedPrototypeFixture(e2eApi, 'approved');

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const protoPage = new PrototypeReviewPage(page);
    await protoPage.goto(prd.id);

    await expect(protoPage.statusBadge()).toContainText(/approved/i, { timeout: 10_000 });
  });
});
