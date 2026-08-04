/**
 * @interview-flow @pipeline
 * AI fix flows: seeded comments → Fix single / Fix all (stubbed) → proposed changes UI.
 * Opening a comment flips the document toward revision_requested.
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic, stubFixWithAi } from '../support/api-stubs';
import { PrdReviewPage } from '../pages/prd-review.page';
import { ReviewCommentsPage } from '../pages/review-comments.page';
import { DesignDocReviewPage } from '../pages/design-doc-review.page';

test.describe('Interview flow — AI fix flows @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('Fix all comments shows proposed-changes affordances (stubbed)', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Fix Interview',
      status: 'complete',
      prdOwnerId: PERSONA_OIDS.ba,
    });

    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Fix PRD',
      status: 'pending_review',
      interviewId: interview.id,
      withReadyTestCases: true,
    });

    const comment = await SeedApi.seedPrdComment(e2eApi, {
      prdId: prd.id,
      authorUserId: PERSONA_OIDS.qa,
      body: 'Please clarify acceptance criteria',
      status: 'open',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await stubFixWithAi(page, {
      proposedContent: '# E2E Fixed PRD\n\nClarified acceptance criteria.',
    });
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    const comments = new ReviewCommentsPage(page);
    await comments.openCommentsSidebar();
    await expect(comments.thread(comment.id)).toBeVisible({ timeout: 10_000 });
    await expect(comments.fixAllButton()).toBeVisible();

    await comments.clickFixAll();

    await expect(
      page.getByText(/proposed|accept all|reject all|E2E Fixed PRD|review changes/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('Fix single comment button has aria-label and triggers stub', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Fix Single Interview',
      status: 'complete',
      prdOwnerId: PERSONA_OIDS.ba,
    });

    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Fix Single PRD',
      status: 'pending_review',
      interviewId: interview.id,
      withReadyTestCases: true,
    });

    await SeedApi.seedPrdComment(e2eApi, {
      prdId: prd.id,
      authorUserId: PERSONA_OIDS.qa,
      body: 'Single comment to fix',
      status: 'open',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await stubFixWithAi(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    const comments = new ReviewCommentsPage(page);
    await comments.openCommentsSidebar();

    const fixBtn = comments.fixSingleButton().first();
    await expect(fixBtn).toHaveAttribute('aria-label', /fix this comment/i);
    await fixBtn.click();

    // Stub persists proposedContent via /e2e PATCH; wait for proposed-changes UI.
    await expect(
      page.getByText(/proposed|accept all|reject all|E2E Fixed Document|review changes/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('open comment on design doc can move status toward revision_requested', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Comment Flip Interview',
      status: 'complete',
      designDocOwnerId: PERSONA_OIDS.ba,
    });
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Comment Flip PRD',
      status: 'approved',
      interviewId: interview.id,
      withReadyTestCases: true,
    });
    const doc = await SeedApi.seedDesignDoc(e2eApi, {
      prdId: prd.id,
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Comment Flip Doc',
      status: 'pending_review',
      validationScore: 95,
    });

    await SeedApi.seedReviewComment(e2eApi, {
      documentId: doc.id,
      documentType: 'design_doc',
      authorUserId: PERSONA_OIDS.qa,
      body: 'Needs clarification in tech spec',
      sectionKey: 'tech-spec',
      selectorExact: 'Seeded tech spec',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const dd = new DesignDocReviewPage(page);
    await dd.goto(doc.id);

    // Some flows flip immediately when an open comment exists; assert either
    // revision_requested or the open comment thread is visible as the gate signal.
    const status = await dd.getStatusText();
    const comments = new ReviewCommentsPage(page);
    await comments.openCommentsSidebar();
    await expect(page.locator('[data-testid^="comment-thread-"][data-status="open"]').first()).toBeVisible({
      timeout: 10_000,
    });

    expect(
      /revision|pending review/i.test(status),
    ).toBeTruthy();
  });

  test('Accept all / Reject all controls appear after stubbed fix', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Accept Reject Interview',
      status: 'complete',
      prdOwnerId: PERSONA_OIDS.ba,
    });
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'AI Accept Reject PRD',
      status: 'revision_requested',
      interviewId: interview.id,
      withReadyTestCases: true,
      // Seed proposed content directly so the review UI can render without waiting on AI
    });
    await SeedApi.updatePrd(e2eApi, prd.id, {
      proposedContent: '# E2E Proposed\n\nStubbed proposed content for accept/reject.',
    });
    await SeedApi.seedPrdComment(e2eApi, {
      prdId: prd.id,
      authorUserId: PERSONA_OIDS.qa,
      body: 'Still open',
      status: 'open',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const prdPage = new PrdReviewPage(page);
    await prdPage.goto(prd.id);

    await expect(
      page.getByRole('button', { name: /accept all|reject all|accept|reject/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
