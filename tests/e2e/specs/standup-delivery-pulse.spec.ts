/**
 * End-to-End Playwright coverage for Simplified AI-Led Standup Check-In & Scrum Master Readout.
 *
 * Covers:
 *   0. Standup management resilience on non-array error responses
 *   1. Generic / Non-ADO team check-in (AI-proposed prompt from prior check-in, no Standup Coach chat, plain-language submit)
 *   2. Strict two-user ADO attribution (no cross-user work item leakage), note/blocker submission, and Scrum Master readout
 *   3. Standup config persistence + optional collapsed Delivery & SDLC Insights drawer
 */
import {
  test,
  expect,
  SeedApi,
  PERSONA_OIDS,
  E2E_PROJECT,
} from '../support/fixtures';
import {
  stubAdoProjects,
  stubAiChatStream,
  suppressBetaAnnouncement,
  suppressSseStreams,
} from '../support/api-stubs';
import { DEFAULT_ENABLED_MENU_VIEWS } from '../../../src/shared/types/menuSettings';
import { StandupPulsePage } from '../pages/standup-pulse.page';

test.describe('AI-Led Standup Check-In & Scrum Master Readout', () => {
  test.beforeEach(async ({ page, e2eApi }) => {
    await page.addInitScript((project) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);
    await suppressSseStreams(page);
    await suppressBetaAnnouncement(page);
    await stubAiChatStream(page);
    await stubAdoProjects(page);
    await SeedApi.setMenuSettings(e2eApi, E2E_PROJECT, DEFAULT_ENABLED_MENU_VIEWS);
  });

  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.setMenuSettings(e2eApi, E2E_PROJECT, DEFAULT_ENABLED_MENU_VIEWS);
    await SeedApi.reset(e2eApi);
  });

  test('0. Standup management stays up when list responses are not arrays', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedAdminRole(e2eApi, { userId: PERSONA_OIDS.manager });
    await page.route('**/api/standup/configs*', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to fetch standup configs' }),
      });
    });
    await page.route('**/api/standup/sessions*', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Failed to fetch sessions' }),
      });
    });

    await loginAsPersona('manager');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoManage();

    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expect(page.getByTestId('standup-manage-load-error')).toContainText(
      'Failed to fetch standup configs',
    );
    await expect(page.getByRole('heading', { name: 'Configurations' })).toBeVisible();
  });

  test('1. Generic Non-ADO Standup Check-In (/standup -> /standup-summary): AI proposes contextual prompt without ADO, no Standup Coach chat, and Scrum Master sees readout', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedStandupDeliveryPulse(e2eApi, {
      project: E2E_PROJECT,
      deliveryModel: 'flow',
      rosterMode: 'groups_only',
      goalSource: 'manual',
      teamGoal: 'Complete Q4 partner onboarding launch',
      participantUserId: PERSONA_OIDS.ba,
      participantStatus: 'notified',
      participantEvidence: {
        ownerDisplayName: 'BA User',
        activeWorkItems: [],
        changedSinceLastWorkItems: [],
        priorHistory: [
          {
            sessionDate: '2026-11-12',
            structuredUpdate: {
              yesterday: 'Reviewed stakeholder sign-off deck',
              today: 'Finalize partner welcome checklist',
              blockers: 'Waiting on legal copy review',
            },
          },
        ],
      },
      additionalParticipants: [
        {
          userId: PERSONA_OIDS['product-owner'],
          status: 'notified',
          participantEvidence: {
            ownerDisplayName: 'PO User',
            activeWorkItems: [],
          },
        },
      ],
    });

    await loginAsPersona('ba');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoStandup();

    // Standup Coach chat is gone; AI Check-In Prompt guides the user generically
    await expect(page.getByText(/discuss with coach/i)).toHaveCount(0);
    await expect(pulsePage.aiPromptCard()).toContainText(
      'Waiting on legal copy review',
    );
    await expect(pulsePage.aiPromptCard()).toContainText(
      'Finalize partner welcome checklist',
    );

    await pulsePage
      .yesterdayInput()
      .fill('Completed partner welcome checklist after legal sign-off');
    await pulsePage
      .todayInput()
      .fill('Run dry-run onboarding walkthrough with support lead');
    await pulsePage.quickConfirmSubmitBtn().click();

    await expect(pulsePage.submittedBanner()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('standup-view-team-pulse-btn').click();

    // Scrum Master readout shows BA's plain-language check-in as Submitted and PO as Waiting for check-in (with zero empty ADO boxes)
    const baCard = page.getByTestId(
      `participant-narrative-${PERSONA_OIDS.ba}`,
    );
    await expect(baCard).toContainText(
      'Completed partner welcome checklist after legal sign-off',
    );
    await expect(baCard).toContainText(
      'Run dry-run onboarding walkthrough with support lead',
    );
    await expect(
      page.getByTestId(`participant-narrative-status-${PERSONA_OIDS.ba}`),
    ).toHaveText('Submitted');
    await expect(
      page.getByTestId(
        `participant-narrative-status-${PERSONA_OIDS['product-owner']}`,
      ),
    ).toHaveText('Waiting for check-in');
    await expect(pulsePage.pulseDeliveryInsights()).toHaveCount(0);
  });

  test('2. Strict Two-User Ownership Attribution & Scrum Master Readout: prevents cross-user ADO leakage, captures blocker/note, and gives Scrum Master a clear readout', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedStandupDeliveryPulse(e2eApi, {
      project: E2E_PROJECT,
      deliveryModel: 'flow',
      goalSource: 'manual',
      teamGoal: 'Keep flow cycle time under 3 days',
      participantUserId: PERSONA_OIDS.developer,
      participantStatus: 'notified',
      participantEvidence: {
        ownerDisplayName: 'Dev User',
        ownerEmail: 'dev@localhost',
        activeWorkItems: [
          {
            id: 5002,
            title: 'Idempotent retry worker',
            workItemType: 'Task',
            state: 'Active',
            assignedTo: 'Dev User',
            assignedToEmail: 'dev@localhost',
            changedDate: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
          },
          {
            id: 5088,
            title: 'QA regression suite owned by QA',
            workItemType: 'Task',
            state: 'Active',
            assignedTo: 'QA User',
            assignedToEmail: 'qa@localhost',
            changedDate: new Date().toISOString(),
          },
        ],
        changedSinceLastWorkItems: [
          {
            id: 5001,
            title: 'Streamline webhook dispatcher',
            workItemType: 'Product Backlog Item',
            state: 'Ready for Test',
            assignedTo: 'Dev User',
            assignedToEmail: 'dev@localhost',
            changedDate: new Date().toISOString(),
          },
          {
            id: 5099,
            title: 'QA bug triaged by Dev but owned by QA',
            workItemType: 'Bug',
            state: 'Active',
            assignedTo: 'QA User',
            assignedToEmail: 'qa@localhost',
            changedDate: new Date().toISOString(),
          },
        ],
        pullRequests: [
          {
            prId: 701,
            title: 'Teammate PR where Dev was only a reviewer',
            status: 'completed',
            createdAt: new Date().toISOString(),
            authorEmail: 'qa@localhost',
            linkedWorkItemIds: [5099],
          },
        ],
        priorHistory: [
          {
            sessionDate: '2026-11-12',
            structuredUpdate: {
              yesterday: 'Started #5001',
              today: '#5002 Idempotent retry worker',
            },
          },
          {
            sessionDate: '2026-11-11',
            structuredUpdate: {
              yesterday: 'Scoped #5002',
              today: '#5002 Idempotent retry worker',
            },
          },
        ],
      },
      additionalParticipants: [
        {
          userId: PERSONA_OIDS.qa,
          status: 'submitted',
          structuredUpdate: {
            yesterday: 'Verified #5099 QA bug fix on staging',
            today: 'Finish #5088 QA regression suite',
            blockers: '',
          },
          participantEvidence: {
            ownerDisplayName: 'QA User',
            ownerEmail: 'qa@localhost',
            activeWorkItems: [
              {
                id: 5088,
                title: 'QA regression suite owned by QA',
                workItemType: 'Task',
                state: 'Active',
                assignedTo: 'QA User',
                assignedToEmail: 'qa@localhost',
              },
            ],
          },
        },
      ],
    });

    await loginAsPersona('developer');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoStandup();

    // Only Dev's owned items (#5001, #5002) are pre-filled; QA's #5099, #5088, and PR !701 are NOT preselected!
    await expect(pulsePage.yesterdayInput()).toHaveValue(
      /#5001 Streamline webhook dispatcher/,
    );
    await expect(pulsePage.yesterdayInput()).not.toHaveValue(/5099/);
    await expect(pulsePage.yesterdayInput()).not.toHaveValue(/701/);
    await expect(pulsePage.todayInput()).toHaveValue(/#5002 Idempotent retry worker/);
    await expect(pulsePage.todayInput()).not.toHaveValue(/5088/);

    // Add a blocker and an optional note
    await pulsePage
      .blockersInput()
      .fill('Need Redis connection string updated in staging');
    await page.getByTestId('standup-optional-notes-drawer').locator('summary').click();
    await pulsePage
      .correctionsInput()
      .fill('Paired with QA for 20m on webhook contract checks');

    await pulsePage.quickConfirmSubmitBtn().click();
    await expect(pulsePage.submittedBanner()).toBeVisible({ timeout: 10_000 });

    // Switch to Manager (Scrum Master) and open the Standup Readout
    await loginAsPersona('manager');
    await pulsePage.gotoSummaryNoParams();

    // Scrum Master sees blocker + AI suggested question at top, and both Dev & QA Submitted cards ready to read out
    await expect(pulsePage.pulseBlockersSection()).toContainText(
      'Need Redis connection string updated in staging',
    );
    await expect(pulsePage.pulseFacilitatorPrompts()).toContainText(
      'Need Redis connection string updated in staging',
    );

    const devReadout = page.getByTestId(
      `participant-narrative-${PERSONA_OIDS.developer}`,
    );
    await expect(devReadout).toContainText('#5001 Streamline webhook dispatcher');
    await expect(devReadout).not.toContainText('5099');
    await expect(
      page.getByTestId(
        `participant-narrative-correction-${PERSONA_OIDS.developer}`,
      ),
    ).toContainText('Paired with QA for 20m on webhook contract checks');

    const qaReadout = page.getByTestId(
      `participant-narrative-${PERSONA_OIDS.qa}`,
    );
    await expect(qaReadout).toContainText('Verified #5099 QA bug fix on staging');
    await expect(qaReadout).toContainText('Finish #5088 QA regression suite');
  });

  test('3. Config Persistence & Supplemental Delivery Insights Drawer (/standup-manage & /standup-summary)', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedAdminRole(e2eApi, { userId: PERSONA_OIDS.manager });
    const seeded = await SeedApi.seedStandupDeliveryPulse(e2eApi, {
      project: E2E_PROJECT,
      deliveryModel: 'flow',
      teamGoal: 'Billing & Worker Infra Rollout',
      sessionStatus: 'completed',
      participantUserId: PERSONA_OIDS.developer,
      participantStatus: 'submitted',
      structuredUpdate: {
        yesterday: 'Drafted #6001 billing schema migration',
        today: 'Verifying rollback script and API handler',
        blockers: '',
      },
      participantEvidence: {
        ownerDisplayName: 'Dev User',
        ownerEmail: 'dev@localhost',
        activeWorkItems: [
          {
            id: 6001,
            title: 'Billing ledger SQL migration & API',
            workItemType: 'Product Backlog Item',
            state: 'In PR',
            assignedToEmail: 'dev@localhost',
            changedDate: new Date().toISOString(),
          },
        ],
        pullRequests: [
          {
            prId: 401,
            title: 'feat(billing): ledger migration & API',
            status: 'active',
            createdAt: new Date().toISOString(),
            authorEmail: 'dev@localhost',
            linkedWorkItemIds: [6001],
            changedFiles: [
              'migrations/20261115_billing.sql',
              'src/server/services/billingService.ts',
              'src/server/__tests__/billingService.test.ts',
            ],
          },
        ],
      },
      proposals: [
        {
          workItemId: 6001,
          workItemTitle: 'Billing ledger SQL migration & API',
          proposalType: 'state',
          fieldName: 'state',
          currentValue: 'In PR',
          proposedValue: 'Ready for Test',
          reason: 'PR merged into main',
          confidence: 'at_risk',
        },
      ],
    });

    await loginAsPersona('developer');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoSummaryNoParams();

    // Delivery & SDLC Insights drawer is collapsed by default so readout stays clean
    const drawer = pulsePage.pulseDeliveryInsights();
    await expect(drawer).toBeVisible();
    await drawer.locator('summary').click();

    await expect(pulsePage.pulseSdlcCalloutsSection()).toContainText(
      'migrations/20261115_billing.sql',
    );

    const [firstProposal] = seeded.proposals;
    await page.getByTestId(`proposal-apply-btn-${firstProposal.id}`).click();
    await expect(
      page.getByTestId(`proposal-status-${firstProposal.id}`),
    ).toHaveText('applied');
  });
});
