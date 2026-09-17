/**
 * @interview-flow @pipeline
 * Interview lifecycle: RBAC, status transitions, Generate PRD (stubbed), metadata.
 */
import { test, expect, SeedApi, PERSONA_OIDS, E2E_PROJECT } from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic, stubPrdGeneration } from '../support/api-stubs';
import { devLogin } from '../support/auth';
import { InterviewChatPage } from '../pages/interview-chat.page';
import { InterviewDashboardPage } from '../pages/interview-dashboard.page';
import { NotificationCenterPage } from '../pages/notification-center.page';

const REQUIREMENTS_SKILL_PATH = '.cursor/skills/requirements-phase/SKILL.md';
const RESUMED_REQUIREMENTS_ANSWER =
  'Operations analysts need to compare failed imports before retrying them.';

async function stubResumedRequirementsHistory(
  page: import('@playwright/test').Page,
  threadId: string,
) {
  const messages = [
    {
      id: 'requirements-question-1',
      role: 'agent',
      text: 'Who needs this feature, and what outcome should it provide?',
      ts: '2026-09-17T12:00:00.000Z',
    },
    {
      id: 'requirements-answer-1',
      role: 'user',
      text: RESUMED_REQUIREMENTS_ANSWER,
      ts: '2026-09-17T12:01:00.000Z',
    },
  ];

  await page.route(`**/api/chat/threads/${threadId}`, async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify({
        ...thread,
        messages,
        status: 'idle',
      }),
    });
  });

  await page.route(`**/api/chat/threads/${threadId}/messages`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON() as { text?: string };
    messages.push({
      id: `requirements-answer-${messages.length}`,
      role: 'user',
      text: body.text ?? '',
      ts: new Date().toISOString(),
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, status: 'idle' }),
    });
  });
}

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

  test('PBI-001 AC-0 / VT-10 Given both sequential owners, Then Requirements and Technical chips show their names', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Sequential Phase Owners',
      status: 'in_progress',
      phaseFlow: 'both_sequential',
      requirementsOwnerId: PERSONA_OIDS.ba,
      technicalOwnerId: PERSONA_OIDS.developer,
      requirementsPhaseStatus: 'draft',
      technicalPhaseStatus: 'locked',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    await expect(page.getByTestId('interview-owner-chip-requirements')).toContainText(
      'Requirements: BA Dev User',
    );
    await expect(page.getByTestId('interview-owner-chip-technical')).toContainText(
      'Technical: Dev User',
    );
  });

  test('FEAT-004 AC-0/AC-2 Requirements owner resumes history and can continue', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Requirements Resume',
      status: 'in_progress',
      phaseFlow: 'requirements_only',
      requirementsOwnerId: PERSONA_OIDS.ba,
      requirementsPhaseStatus: 'draft',
      skillPath: REQUIREMENTS_SKILL_PATH,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await stubResumedRequirementsHistory(page, interview.chatThreadId);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    const routedThread = await page.request.get(
      `/api/chat/threads/${interview.chatThreadId}`,
    );
    expect(routedThread.ok()).toBe(true);
    expect((await routedThread.json()).kickoff.skillPath).toBe(REQUIREMENTS_SKILL_PATH);
    await expect(chat.phaseBadge()).toHaveText('Requirements Phase');
    await expect(page.getByText(RESUMED_REQUIREMENTS_ANSWER, { exact: true })).toBeVisible();
    await expect(chat.messageInput()).toBeEnabled();

    const continuedAnswer =
      'Success means analysts can identify the failed records and retry only those records.';
    await chat.messageInput().fill(continuedAnswer);
    await chat.messageInput().press('Enter');
    await expect(page.getByText(continuedAnswer, { exact: true })).toBeVisible();

    await page.reload();
    await chat.waitForReady();
    await expect(page.getByText(RESUMED_REQUIREMENTS_ANSWER, { exact: true })).toBeVisible();
    await expect(page.getByText(continuedAnswer, { exact: true })).toBeVisible();
    await expect(chat.messageInput()).toBeEnabled();
  });

  test('FEAT-004 AC-3 non-owner has a read-only Requirements view in a second context', async ({
    browser,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Requirements Owner Gate',
      status: 'in_progress',
      phaseFlow: 'requirements_only',
      requirementsOwnerId: PERSONA_OIDS.ba,
      requirementsPhaseStatus: 'draft',
      skillPath: REQUIREMENTS_SKILL_PATH,
    });

    const viewerContext = await browser.newContext({
      baseURL: 'http://127.0.0.1:3000',
    });
    const viewerPage = await viewerContext.newPage();
    try {
      await stubAdoProjects(viewerPage);
      await stubAllAiTraffic(viewerPage);
      await stubResumedRequirementsHistory(viewerPage, interview.chatThreadId);
      await devLogin(viewerPage, 'developer');

      const viewerChat = new InterviewChatPage(viewerPage);
      await viewerChat.goto(interview.id);

      await expect(viewerChat.phaseBadge()).toHaveText('Requirements Phase');
      await expect(viewerPage.getByText(RESUMED_REQUIREMENTS_ANSWER, { exact: true })).toBeVisible();
      await expect(viewerChat.phaseReadOnlyNotice()).toHaveText(
        'You are not the owner of this phase and cannot send messages here.',
      );
      await expect(viewerChat.messageInput()).toHaveCount(0);
      await expect(viewerChat.sendMessageButton()).toHaveCount(0);

      const forbidden = await viewerPage.request.post(
        `/api/chat/threads/${interview.chatThreadId}/messages`,
        { data: { text: 'This message must not be accepted.' } },
      );
      expect(forbidden.status()).toBe(403);
      await expect(forbidden.json()).resolves.toEqual({
        error: 'Only the assigned Requirements owner can send messages in this phase',
      });
    } finally {
      await viewerContext.close();
    }
  });

  test('FEAT-002 approve unlocks Technical, then amend notifies Requirements owner', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Phase Summary Lifecycle',
      status: 'in_progress',
      phaseFlow: 'both_sequential',
      requirementsOwnerId: PERSONA_OIDS.ba,
      technicalOwnerId: PERSONA_OIDS.developer,
      requirementsPhaseStatus: 'draft',
      technicalPhaseStatus: 'locked',
      requirementsSummary: '',
      technicalSummary: '',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    const chat = new InterviewChatPage(page);
    const notifications = new NotificationCenterPage(page);

    await loginAsPersona('ba');
    await chat.goto(interview.id);
    await chat.approvePhaseSummary(
      'requirements',
      'Users need an owner-approved phase summary before Technical begins.',
    );
    await expect(chat.phaseSummaryApproved('requirements')).toBeVisible();

    await loginAsPersona('developer');
    await chat.goto(interview.id);
    await notifications.clickBell();
    await expect(page.getByText('Technical Phase Unlocked', { exact: true })).toBeVisible();
    await notifications.clickBell();

    await chat.amendRequirementsSummary(
      'Users need an owner-approved phase summary before Technical begins. Technical clarification added.',
    );
    await expect(chat.phaseSummaryApproved('requirements')).toBeVisible();

    await loginAsPersona('ba');
    await chat.goto(interview.id);
    await notifications.clickBell();
    await expect(page.getByText('Requirements Summary Amended', { exact: true })).toBeVisible();
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
