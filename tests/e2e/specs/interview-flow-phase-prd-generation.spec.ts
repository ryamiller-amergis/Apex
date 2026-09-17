/**
 * @interview-flow
 * FEAT-003 automatic PRD status after the final configured phase is approved.
 *
 * Phase approval and PRD rows are seeded so these tests exercise the observable
 * lifecycle without starting the real AI generation pipeline.
 */
import {
  test,
  expect,
  SeedApi,
  PERSONA_OIDS,
  E2E_PROJECT,
} from '../support/fixtures';
import { stubAdoProjects, stubAllAiTraffic } from '../support/api-stubs';
import { InterviewChatPage } from '../pages/interview-chat.page';

test.describe('Interview flow — phase PRD generation @interview-flow', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('VT-11 / PBI-006 AC-0: approved Technical-only phase shows generating, then ready and opens the linked PRD', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Technical Phase PRD Lifecycle',
      status: 'in_progress',
      phaseFlow: 'technical_only',
      technicalOwnerId: PERSONA_OIDS.ba,
      technicalPhaseStatus: 'approved',
      technicalSummary:
        'Use the existing PRD pipeline after Technical approval.',
      technicalApprovedAt: new Date().toISOString(),
      prdOwnerId: PERSONA_OIDS.ba,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    await expect(chat.prdTriggerStatus()).toHaveText('PRD generating');
    await expect(chat.openPrdFromPhaseButton(interview.id)).toHaveCount(0);

    const prd = await SeedApi.seedPrd(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Generated From Technical Phase',
      status: 'draft',
      interviewId: interview.id,
    });

    // Reload deterministically instead of waiting for the normal five-second poll.
    await chat.goto(interview.id);
    await expect(chat.prdTriggerStatus()).toContainText('PRD ready');
    await expect(chat.openPrdFromPhaseButton(interview.id)).toBeEnabled();

    await chat.openPrdFromPhaseButton(interview.id).click();
    await expect(page).toHaveURL(new RegExp(`/backlog/prd/${prd.id}$`));
  });

  test('VT-12 / PBI-006 AC-2: Requirements approval alone remains pending final phase', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Sequential PRD Pending',
      status: 'in_progress',
      phaseFlow: 'both_sequential',
      requirementsOwnerId: PERSONA_OIDS.ba,
      technicalOwnerId: PERSONA_OIDS.developer,
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'draft',
      requirementsSummary:
        'Requirements are approved; Technical work is still in draft.',
      technicalSummary: 'Technical phase is not approved.',
      requirementsApprovedAt: new Date().toISOString(),
      prdOwnerId: PERSONA_OIDS.ba,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    await expect(chat.prdTriggerStatus()).toHaveText(
      'PRD pending final phase approval'
    );
    await expect(chat.retryPrdFromPhaseButton(interview.id)).toHaveCount(0);
    await expect(chat.openPrdFromPhaseButton(interview.id)).toHaveCount(0);
  });

  test('PBI-006 AC-1: stale final-phase approval shows failed status and Retry for interviews:manage', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Technical Phase PRD Retry',
      status: 'in_progress',
      phaseFlow: 'technical_only',
      technicalOwnerId: PERSONA_OIDS.ba,
      technicalPhaseStatus: 'approved',
      technicalSummary: 'The approved phase has no linked PRD.',
      technicalApprovedAt: new Date(Date.now() - 61_000).toISOString(),
      prdOwnerId: PERSONA_OIDS.ba,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('ba');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    await expect(chat.prdTriggerStatus()).toContainText(
      'PRD generation failed'
    );
    await expect(chat.retryPrdFromPhaseButton(interview.id)).toBeEnabled();
    await expect(
      chat.retryPrdFromPhaseButton(interview.id)
    ).toHaveAccessibleName('Retry automatic PRD generation');
  });
});
