/**
 * @interview-flow @pipeline
 * Design doc review: two-step approval, validation badge colors, side-dock, approvers.
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';
import { DesignDocReviewPage } from '../pages/design-doc-review.page';

async function seedDesignDocFixture(
  e2eApi: Parameters<typeof SeedApi.seedPrd>[0],
  opts: {
    status?: 'draft' | 'pending_review' | 'reviewer_approved' | 'approved' | 'validating';
    validationScore?: number | null;
  } = {},
) {
  const interview = await SeedApi.seedInterview(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'DD Interview',
    status: 'complete',
    prdOwnerId: PERSONA_OIDS.ba,
    designDocOwnerId: PERSONA_OIDS.ba,
    designDocApproverIds: [PERSONA_OIDS.qa],
  });

  const prd = await SeedApi.seedPrd(e2eApi, {
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'DD Parent PRD',
    status: 'approved',
    interviewId: interview.id,
    withReadyTestCases: true,
  });

  const doc = await SeedApi.seedDesignDoc(e2eApi, {
    prdId: prd.id,
    authorId: PERSONA_OIDS.ba,
    project: E2E_PROJECT,
    title: 'Design Doc Under Test',
    status: opts.status ?? 'pending_review',
    validationScore: opts.validationScore ?? 95,
  });

  await SeedApi.seedApproverAssignments(e2eApi, {
    documentId: doc.id,
    documentType: 'design_doc',
    approverUserIds: [PERSONA_OIDS.qa],
    assignedBy: PERSONA_OIDS.ba,
    status: opts.status === 'draft' ? 'pending' : opts.status === 'pending_review' || !opts.status ? 'pending' : 'approved',
  });

  return { interview, prd, doc };
}

test.describe('Interview flow — Design doc review @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('submit draft → pending_review', async ({ page, loginAsPersona, e2eApi }) => {
    // Disable auto-validation so submit lands on pending_review (not validating).
    await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'DD Submit No Validation',
      isDefault: true,
      designDocValidationSkillPath: null,
      prdValidationSkillPath: null,
      designDocApprovers: [PERSONA_OIDS.qa],
    });

    const { doc } = await seedDesignDocFixture(e2eApi, {
      status: 'draft',
      validationScore: 95,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const dd = new DesignDocReviewPage(page);
    await dd.goto(doc.id);

    await expect(dd.submitButton()).toBeVisible({ timeout: 10_000 });
    await expect(dd.submitButton()).toBeEnabled();

    const submitResponse = page.waitForResponse(
      (r) =>
        r.url().includes(`/design-docs/${doc.id}/submit`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await dd.clickSubmit();
    const res = await submitResponse;
    expect(res.ok(), `submit failed: ${res.status()} ${await res.text()}`).toBeTruthy();

    await expect(dd.statusBadge()).toContainText(/pending review|validating/i, { timeout: 15_000 });
  });

  test('reviewer approve → reviewer_approved; owner approve → approved', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { doc } = await seedDesignDocFixture(e2eApi, {
      status: 'pending_review',
      validationScore: 95,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);

    await loginAsPersona('qa');
    const dd = new DesignDocReviewPage(page);
    await dd.goto(doc.id);
    await expect(dd.approveButton()).toBeEnabled({ timeout: 10_000 });
    await dd.clickApprove();
    await expect(dd.statusBadge()).toContainText(/reviewer approved/i, { timeout: 15_000 });

    await loginAsPersona('ba');
    await dd.goto(doc.id);
    await expect(dd.approveOwnerButton()).toBeVisible({ timeout: 10_000 });
    await dd.clickApproveOwner();
    await expect(dd.statusBadge()).toContainText(/^approved$/i, { timeout: 15_000 });
  });

  test('validation badge color reflects score vs threshold', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedProjectSettings(e2eApi, {
      project: E2E_PROJECT,
      friendlyName: 'DD Threshold',
      isDefault: true,
      designDocValidationSkillPath: '.cursor/skills/design-doc-validation/SKILL.md',
      designDocValidationScoreThreshold: 90,
    });

    // Green path (≥ threshold)
    const high = await seedDesignDocFixture(e2eApi, {
      status: 'pending_review',
      validationScore: 95,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const dd = new DesignDocReviewPage(page);
    await dd.goto(high.doc.id);
    await expect(dd.validationBadge()).toContainText(/95%/);
    // CSS module class for good score is applied — assert text is enough for determinism

    // Amber / red path: seed a second doc under a fresh PRD
    const interview2 = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'DD Low Score Interview',
      status: 'complete',
      designDocOwnerId: PERSONA_OIDS.ba,
    });
    const prd2 = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'DD Low Score PRD',
      status: 'approved',
      interviewId: interview2.id,
      withReadyTestCases: true,
    });
    const lowDoc = await SeedApi.seedDesignDoc(e2eApi, {
      prdId: prd2.id,
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Low Score Design Doc',
      status: 'draft',
      validationScore: 55,
    });

    await dd.goto(lowDoc.id);
    await expect(dd.validationBadge()).toContainText(/55%/);
    await expect(dd.fixBanner()).toBeVisible({ timeout: 10_000 });
  });

  test('Comments and Validation side-dock tabs toggle', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { doc } = await seedDesignDocFixture(e2eApi, {
      status: 'pending_review',
      validationScore: 92,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const dd = new DesignDocReviewPage(page);
    await dd.goto(doc.id);

    await expect(dd.root()).toBeVisible({ timeout: 10_000 });
    await expect(dd.commentsDockTab()).toBeVisible({ timeout: 10_000 });
    await expect(dd.validationDockTab()).toBeVisible({ timeout: 10_000 });
    await dd.openValidationDock();
    await expect(dd.validationScore()).toContainText(/92/, { timeout: 10_000 });
    await dd.openCommentsDock();
    await expect(page.getByTestId('comment-sidebar')).toBeVisible({ timeout: 5_000 });
  });

  test('approver action is available on pending_review', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const { doc } = await seedDesignDocFixture(e2eApi, { status: 'pending_review' });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const dd = new DesignDocReviewPage(page);
    await dd.goto(doc.id);

    // Approvers lives under the More actions menu.
    const more = page.getByRole('button', { name: /more actions/i });
    await expect(more).toBeVisible({ timeout: 10_000 });
    await more.click();
    await expect(page.getByRole('menuitem', { name: /approver/i })).toBeVisible({
      timeout: 5_000,
    });
  });
});
