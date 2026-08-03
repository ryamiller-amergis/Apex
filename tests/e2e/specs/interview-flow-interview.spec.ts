/**
 * @interview-flow @pipeline
 * Interview lifecycle: RBAC, status transitions, Generate PRD (stubbed), metadata.
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic, stubPrdGeneration } from '../support/api-stubs';
import { InterviewChatPage } from '../pages/interview-chat.page';
import { InterviewDashboardPage } from '../pages/interview-dashboard.page';

test.describe('Interview flow — Interview @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('BA can start interview; developer start button is disabled', async ({
    page,
    loginAsPersona,
  }) => {
    await stubAdoProjects(page);
    await stubAllAiTraffic(page);

    await loginAsPersona('ba');
    const dash = new InterviewDashboardPage(page);
    await dash.goto();
    await expect(dash.startInterviewButton()).toBeEnabled();

    await loginAsPersona('developer');
    await dash.goto();
    await expect(dash.startInterviewButton()).toBeDisabled();
  });

  test('complete / reopen / archive gating and owner chips render', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Interview Lifecycle',
      status: 'in_progress',
      prdOwnerId: PERSONA_OIDS.ba,
      designDocOwnerId: PERSONA_OIDS.developer,
      designPrototypeOwnerId: PERSONA_OIDS['ui-ux'],
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    await expect(chat.statusBadge()).toContainText(/in progress/i);
    await expect(chat.ownerChips()).toBeVisible();
    await expect(page.getByTestId('interview-owner-chip-prd')).toBeVisible();

    await chat.clickComplete();
    await expect(chat.statusBadge()).toContainText(/complete/i, { timeout: 10_000 });
    await expect(chat.generatePrdButton()).toBeVisible();
    await expect(chat.reopenButton()).toBeEnabled();

    await chat.clickArchive();
    await expect(chat.statusBadge()).toContainText(/archiv/i, { timeout: 10_000 });
  });

  test('Generate PRD navigates to PRD review (AI stubbed)', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Generate PRD Nav',
      status: 'complete',
      prdOwnerId: PERSONA_OIDS.ba,
    });

    // Seed destination PRD without linking to the interview so Generate stays enabled.
    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Stub Destination PRD',
      status: 'draft',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await stubPrdGeneration(page, { id: prd.id, prdId: prd.id, title: prd.title });
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);
    await expect(chat.generatePrdButton()).toBeEnabled();
    await chat.clickGeneratePrd();

    await expect(page).toHaveURL(new RegExp(`/backlog/prd/${prd.id}`), { timeout: 15_000 });
  });

  test('reopen disabled when a PRD already exists for the interview', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Locked Reopen',
      status: 'complete',
      prdOwnerId: PERSONA_OIDS.ba,
    });
    await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Linked PRD',
      status: 'draft',
      interviewId: interview.id,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);
    await expect(chat.reopenButton()).toBeDisabled();
    await expect(chat.generatePrdButton()).toBeDisabled();
  });
});
