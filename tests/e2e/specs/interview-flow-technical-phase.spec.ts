/**
 * @interview-flow @pipeline
 * FEAT-005 Wave 4: Technical phase owner, lock, and read-only journeys.
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

const ORIGINAL_PROMPT =
  'Create an audit export that account administrators can download.';
const APPROVED_REQUIREMENTS =
  'The export must be CSV, restricted to account administrators, and retain audit timestamps.';
const AMENDMENT_CONFIRMATION =
  'The amended requirements summary has been handed to Apex for the Requirements owner to see. Continuing with architecture.';

test.describe('FEAT-005 Technical phase @interview-flow @pipeline', () => {
  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.reset(e2eApi);
  });

  test('VT-10 / PBI-008 AC-0 owner resumes Technical with seeded context and can send', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Technical Owner Resume',
      status: 'in_progress',
      phaseFlow: 'both_sequential',
      requirementsOwnerId: PERSONA_OIDS.ba,
      technicalOwnerId: PERSONA_OIDS.developer,
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'draft',
      requirementsSummary: APPROVED_REQUIREMENTS,
      requirementsApprovedAt: '2026-09-17T12:05:00.000Z',
      originalPrompt: ORIGINAL_PROMPT,
      technicalMessages: [
        {
          role: 'agent',
          text: 'Which system owns the audit records used by this export?',
        },
        {
          role: 'agent',
          text: AMENDMENT_CONFIRMATION,
        },
      ],
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('developer');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);
    await chat.openTechnicalPhase();

    await expect(chat.technicalTab()).toHaveAttribute('aria-selected', 'true');
    await expect(chat.technicalPhaseBadge()).toHaveText('Technical Phase');
    await expect(chat.technicalSeededContext()).toBeVisible();
    await expect(chat.technicalOriginalPromptDisclosure()).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(chat.technicalRequirementsDisclosure()).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(chat.technicalOriginalPromptBody()).toBeHidden();
    await expect(chat.technicalRequirementsBody()).toBeHidden();

    await chat.technicalOriginalPromptDisclosure().click();
    await expect(chat.technicalOriginalPromptDisclosure()).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(chat.technicalOriginalPromptBody()).toHaveText(
      ORIGINAL_PROMPT
    );

    await chat.technicalRequirementsDisclosure().click();
    await expect(chat.technicalRequirementsDisclosure()).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(chat.technicalRequirementsBody()).toHaveText(
      APPROVED_REQUIREMENTS
    );

    await expect(chat.technicalAmendmentBubble()).toContainText(
      AMENDMENT_CONFIRMATION
    );
    await expect(chat.composer()).toBeVisible();
    await expect(chat.messageInput()).toBeEnabled();

    const ownerMessage =
      'The reporting service owns the audit records and exposes a paged read API.';
    await chat.messageInput().fill(ownerMessage);
    await chat.messageInput().press('Enter');
    await expect(page.getByText(ownerMessage, { exact: true })).toBeVisible();
  });

  test('PBI-008 AC-2 keeps Technical locked while Requirements is draft', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Technical Locked By Draft Requirements',
      status: 'in_progress',
      phaseFlow: 'both_sequential',
      requirementsOwnerId: PERSONA_OIDS.ba,
      technicalOwnerId: PERSONA_OIDS.developer,
      requirementsPhaseStatus: 'draft',
      technicalPhaseStatus: 'locked',
      requirementsSummary: 'This draft has not been approved.',
      originalPrompt: ORIGINAL_PROMPT,
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('developer');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);

    await expect(chat.technicalTab()).toHaveAttribute('aria-disabled', 'true');
    await chat.technicalTab().click({ force: true });
    await expect(
      page.getByTestId('interview-phase-tab-technical-locked-tooltip')
    ).toHaveText('Approve the Requirements summary to unlock Technical.');
    await expect(chat.technicalPhaseBadge()).toHaveCount(0);
    await expect(chat.technicalSeededContext()).toHaveCount(0);
    await expect(page.getByTestId('technical-phase-start')).toHaveCount(0);
    await expect(chat.composer()).toHaveCount(0);
  });

  test('PBI-008 AC-3 non-owner sees an already-started Technical phase read-only', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const interview = await SeedApi.seedInterview(e2eApi, {
      authorId: PERSONA_OIDS.ba,
      project: E2E_PROJECT,
      title: 'Technical Non Owner',
      status: 'in_progress',
      phaseFlow: 'both_sequential',
      requirementsOwnerId: PERSONA_OIDS.ba,
      technicalOwnerId: PERSONA_OIDS.ba,
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'draft',
      requirementsSummary: APPROVED_REQUIREMENTS,
      requirementsApprovedAt: '2026-09-17T12:05:00.000Z',
      originalPrompt: ORIGINAL_PROMPT,
      technicalMessages: [
        {
          role: 'agent',
          text: 'Seeded Technical discussion visible to read-only viewers.',
        },
      ],
    });

    await stubAdoProjects(page);
    await stubAllAiTraffic(page);
    await loginAsPersona('developer');

    const chat = new InterviewChatPage(page);
    await chat.goto(interview.id);
    await chat.openTechnicalPhase();

    await expect(chat.technicalPhaseBadge()).toHaveText('Technical Phase');
    await expect(
      page.getByText(
        'Seeded Technical discussion visible to read-only viewers.',
        { exact: true }
      )
    ).toBeVisible();
    await expect(chat.technicalReadOnlyNotice()).toContainText(
      'You are not the owner of this phase and cannot send messages here.'
    );
    await expect(chat.composer()).toHaveCount(0);
    await expect(chat.messageInput()).toHaveCount(0);
    await expect(chat.sendMessageButton()).toHaveCount(0);
  });
});
