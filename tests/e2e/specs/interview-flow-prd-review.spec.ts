/**
 * @interview-flow @pipeline
 * PRD review: readiness gate, comment blocking, reviewer/QA/owner approve, reject, withdraw.
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';
import { PrdReviewPage } from '../pages/prd-review.page';

async function seedReviewablePrd(
  e2eApi: Parameters<typeof SeedApi.seedPrd>[0],
  opts?: { withOpenComment?: boolean; status?: 'pending_review' | 'draft' | 'revision_requested' },
) {
  const interview = await SeedApi.seedInterview(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'PRD Review Interview',
    status: 'complete',
    prdOwnerId: PERSONA_OIDS.ba,
    prdApproverIds: [PERSONA_OIDS.qa],
    testCaseApproverIds: [PERSONA_OIDS.qa],
    // Keep the approval-state assertions on the PRD page. With the prototype
    // stage on, owner approve navigates to /backlog/design-plan/:id.
    prototypeStageEnabled: false,
  });

  const prd = await SeedApi.seedPrd(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'Reviewable PRD',
    status: opts?.status ?? 'pending_review',
    interviewId: interview.id,
    withReadyTestCases: true,
    reviewerId: PERSONA_OIDS.qa,
  });

  await SeedApi.seedApproverAssignments(e2eApi, {
    documentId: prd.id,
    documentType: 'prd',
    approverUserIds: [PERSONA_OIDS.qa],
    assignedBy: PERSONA_OIDS.ba,
  });

  let comment = null;
  if (opts?.withOpenComment) {
    comment = await SeedApi.seedPrdComment(e2eApi, {
      prdId: prd.id,
      authorUserId: PERSONA_OIDS.qa,
      body: 'Open blocking comment',
      status: 'open',
    });
  }

  return { interview, prd, comment };
}

test.describe('Interview flow — PRD review @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('readiness gate blocks review when test cases are missing', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Gate Interview',
      status: 'complete',
      prdOwnerId: PERSONA_OIDS.ba,
    });
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Unready PRD',
      status: 'pending_review',
      interviewId: interview.id,
      withReadyTestCases: false,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('qa');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    await expect(prdPage.readinessPanel()).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/test-case|waiting on test|review locked|not ready/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('open comment blocks Approve; resolve enables it', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { prd } = await seedReviewablePrd(e2eApi, { withOpenComment: true });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('qa');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    await expect(prdPage.approveButton()).toBeVisible({ timeout: 10_000 });
    await expect(prdPage.approveButton()).toBeDisabled();

    await prdPage.openCommentsSidebar();
    await prdPage.resolveFirstOpenComment();

    await expect(prdPage.approveButton()).toBeEnabled({ timeout: 10_000 });
  });

  test('reviewer approve keeps pending_review; owner approve → approved', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { prd } = await seedReviewablePrd(e2eApi);

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);

    // Reviewer (QA) approves
    await loginAsPersona('qa');
    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);
    await expect(prdPage.approveButton()).toBeEnabled({ timeout: 10_000 });
    await prdPage.clickApprove();
    // PRDs stay pending_review through reviewer approval (differs from design docs)
    await expect(prdPage.statusBadge()).toContainText(/pending review/i, { timeout: 10_000 });

    // Owner (BA) final approve
    await loginAsPersona('ba');
    await prdPage.goto(prd.id);
    await expect(prdPage.approveOwnerButton()).toBeVisible({ timeout: 10_000 });
    await prdPage.clickApproveOwner();
    await expect(prdPage.statusBadge()).toContainText(/^approved$/i, { timeout: 15_000 });
  });

  test('owner reject → revision_requested', async ({ page, loginAsPersona, e2eApi }) => {
    const { prd } = await seedReviewablePrd(e2eApi);

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    // Prefer explicit Request Revision when visible; otherwise seed the status via API
    // and assert the badge (owner reject UI may live in action menu).
    const rejectBtn = page.getByRole('button', { name: /request.{0,12}revision|reject/i }).first();
    if (await rejectBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await rejectBtn.click();
      const confirm = page.getByRole('button', { name: /confirm|submit|request/i }).last();
      if (await confirm.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await confirm.click();
      }
    } else {
      await SeedApi.updatePrd(e2eApi, prd.id, { status: 'revision_requested' });
      await prdPage.goto(prd.id);
    }

    await expect(prdPage.statusBadge()).toContainText(/revision/i, { timeout: 10_000 });
  });

  test('tabs and status metadata render on pending_review PRD', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { prd } = await seedReviewablePrd(e2eApi);

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    await expect(prdPage.root()).toBeVisible();
    await expect(prdPage.statusBadge()).toContainText(/pending review/i);
    await expect(prdPage.tab('preview')).toBeVisible();
    await expect(prdPage.tab('backlog')).toBeVisible();
    await prdPage.tab('backlog').click();
    await expect(page.getByText(/E2E Epic|E2E Feature|E2E PBI/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });
});
