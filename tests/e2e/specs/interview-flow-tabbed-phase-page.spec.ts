/**
 * @interview-flow @pipeline
 * FEAT-006: both-sequential phase tabs lock and unlock from server state.
 */
import {
  E2E_PROJECT,
  expect,
  PERSONA_OIDS,
  SeedApi,
  test,
} from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';
import { InterviewChatPage } from '../pages/interview-chat.page';

test.describe('FEAT-006 tabbed phase page @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('PBI-009 AC-0/1/2 locks Technical until server-confirmed Requirements approval without auto-switching', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Tabbed Sequential Phases',
      status: 'in_progress',
      phaseFlow: 'both_sequential',
      requirementsOwnerId: PERSONA_OIDS.ba,
      technicalOwnerId: PERSONA_OIDS.ba,
      requirementsPhaseStatus: 'draft',
      technicalPhaseStatus: 'locked',
      requirementsSummary: '',
      technicalSummary: '',
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    const requirementsTab = page.getByTestId(
      'interview-phase-tab-requirements',
    );
    const technicalTab = page.getByTestId('interview-phase-tab-technical');

    await expect(page.getByTestId('interview-phase-tabs')).toBeVisible();
    await expect(requirementsTab).toHaveAttribute('aria-selected', 'true');
    await expect(technicalTab).toHaveAttribute('aria-disabled', 'true');
    await expect(chat.phaseSummaryContent('requirements')).toBeVisible();
    await expect(chat.phaseSummaryContent('technical')).toHaveCount(0);

    await technicalTab.click({ force: true });

    await expect(requirementsTab).toHaveAttribute('aria-selected', 'true');
    await expect(technicalTab).toHaveAttribute('aria-selected', 'false');
    await expect(
      page.getByTestId('interview-phase-tab-technical-locked-tooltip'),
    ).toHaveText(
      'Approve the Requirements summary to unlock Technical.',
    );

    const approvalResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST'
      && new URL(response.url()).pathname
        === `/api/interviews/${interview.id}/phases/requirements/approve`,
    );
    await chat.approvePhaseSummary(
      'requirements',
      'Requirements are complete and ready for the Technical phase.',
    );
    await expect((await approvalResponse).ok()).toBe(true);

    await expect(technicalTab).not.toHaveAttribute('aria-disabled', 'true');
    await expect(requirementsTab).toHaveAttribute('aria-selected', 'true');
    await expect(chat.phaseSummaryApproved('requirements')).toBeVisible();

    await technicalTab.click();

    await expect(technicalTab).toHaveAttribute('aria-selected', 'true');
    await expect(requirementsTab).toHaveAttribute('aria-selected', 'false');
    await expect(chat.phaseSummaryContent('requirements')).toHaveCount(0);
    await expect(chat.phaseSummaryContent('technical')).toBeVisible();
  });
});
