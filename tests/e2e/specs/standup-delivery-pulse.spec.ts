/**
 * AC-01..AC-10: End-to-End Playwright coverage for Standup & Calendar Delivery Pulse.
 *
 * Runs offline against local Express + Vite + PostgreSQL using /e2e/seed/standup-delivery-pulse
 * and stubbed ADO endpoints — zero live external ADO or AI calls.
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

test.describe('Standup & Calendar Delivery Pulse', () => {
  test.beforeEach(async ({ page, e2eApi }) => {
    await page.addInitScript((project) => {
      window.localStorage.setItem('selectedProject', project);
      window.localStorage.setItem('selectedAreaPath', project);
    }, E2E_PROJECT);
    await suppressSseStreams(page);
    await suppressBetaAnnouncement(page);
    await stubAiChatStream(page);
    await stubAdoProjects(page);
    await SeedApi.setMenuSettings(
      e2eApi,
      E2E_PROJECT,
      DEFAULT_ENABLED_MENU_VIEWS.filter((v) => v !== 'work-board'),
    );
  });

  test.afterEach(async ({ e2eApi }) => {
    await SeedApi.setMenuSettings(e2eApi, E2E_PROJECT, DEFAULT_ENABLED_MENU_VIEWS);
    await SeedApi.reset(e2eApi);
  });

  test('1. Flow Mode Quick Standup: prefilled brief, carryover check, no target-date nagging, and 1-click submit (AC-01, AC-02, AC-03)', async ({
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
      preparedBrief: {
        generatedAt: new Date().toISOString(),
        deliveryModel: 'flow',
        teamGoal: '[E2E] Keep flow cycle time under 3 days',
        accomplishedSinceLast: [
          {
            workItemId: 5001,
            title: 'Streamline webhook dispatcher',
            workItemType: 'Product Backlog Item',
            state: 'Ready for Test',
            evidence: 'ADO update — state [Ready for Test]',
          },
          {
            prId: 88,
            workItemId: 5001,
            title: 'feat: streamline webhook dispatcher',
            evidence: 'Merged PR !88',
          },
        ],
        priorCommitments: [
          {
            summary: '#5002 Idempotent retry worker',
            workItemIds: [5002],
            status: 'untouched',
            note: 'No ADO state change or PR activity recorded since last standup',
          },
        ],
        suggestedToday: [
          {
            workItemId: 5002,
            title: 'Idempotent retry worker',
            workItemType: 'Task',
            state: 'Active',
            targetDate: null,
            iterationPath: null,
            riskFlags: ['Carryover', 'Stale 4d'],
          },
        ],
        detectedExceptions: [
          {
            id: 'stale-5002',
            kind: 'stale_state',
            severity: 'warning',
            message: '#5002 (Idempotent retry worker) has stayed in [Active] for 4 days.',
            workItemId: 5002,
            workItemTitle: 'Idempotent retry worker',
          },
          {
            id: 'untouched-commitment-0',
            kind: 'untouched_commitment',
            severity: 'warning',
            message:
              'Prior commitment untouched: "#5002 Idempotent retry worker" has no recorded ADO or PR activity.',
            workItemId: 5002,
          },
        ],
        openFollowups: [],
      },
    });

    await loginAsPersona('developer');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoStandup();

    await expect(pulsePage.deliveryModelBadge()).toHaveText('Flow');
    await expect(pulsePage.teamGoalBanner()).toContainText(
      'Keep flow cycle time under 3 days',
    );
    await expect(page.getByTestId('standup-brief-accomplished')).toContainText(
      'Streamline webhook dispatcher',
    );
    await expect(page.getByTestId('standup-brief-accomplished')).toContainText(
      'Merged PR !88',
    );
    await expect(page.getByTestId('standup-commitment-status-0')).toHaveText(
      'Carryover',
    );
    await expect(page.getByTestId('standup-exception-stale-5002')).toBeVisible();
    // Flow mode does not show missing target date warnings
    await expect(page.getByTestId('standup-brief-exceptions')).not.toContainText(
      /no target date/i,
    );

    await pulsePage.quickConfirmSubmitBtn().click();

    await expect(pulsePage.submittedBanner()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('standup-submitted-badge')).toHaveText(
      'Submitted',
    );
  });

  test('2. Standup Management Delivery Model Config: configures Milestone model and Team Goal (AC-01, AC-04)', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedAdminRole(e2eApi, { userId: PERSONA_OIDS.manager });
    const seeded = await SeedApi.seedStandupDeliveryPulse(e2eApi, {
      project: E2E_PROJECT,
      deliveryModel: 'flow',
      teamGoal: 'Initial Flow Goal',
      createSession: false,
    });

    await page.route('**/api/projects/*/area-paths*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(['MaxView\\Core']),
      });
    });

    await loginAsPersona('manager');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoManage();

    await page.getByTestId('standup-new-config-btn').click();
    await page.getByTestId('standup-config-project').selectOption(E2E_PROJECT);
    await page
      .getByTestId(`standup-group-checkbox-${seeded.group.id}`)
      .check();

    // Verify default is Flow with target-date checks unchecked
    await expect(page.getByTestId('standup-config-delivery-model')).toHaveValue('flow');
    await expect(
      page.getByTestId('standup-policy-target-date-checks'),
    ).not.toBeChecked();

    // Switch to Milestone — target-date checks auto-enable
    await page
      .getByTestId('standup-config-delivery-model')
      .selectOption('milestone');
    await expect(
      page.getByTestId('standup-policy-target-date-checks'),
    ).toBeChecked();

    await page
      .getByTestId('standup-config-goal-source')
      .selectOption('release_epic');
    await page
      .getByTestId('standup-config-team-goal')
      .fill('[E2E] Ship Milestone Release v3.0');

    await page.getByTestId('standup-config-save-btn').click();

    await expect(
      page.getByText('[E2E] Ship Milestone Release v3.0'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('[data-testid^="standup-config-card-model-"]').filter({ hasText: 'Milestone' }),
    ).toBeVisible();
  });

  test('3. 5-Minute Team Pulse Summary & Proposal Decision: loads without ?session= and confirms/dismisses proposals (AC-06, AC-08)', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const seeded = await SeedApi.seedStandupDeliveryPulse(e2eApi, {
      project: E2E_PROJECT,
      deliveryModel: 'flow',
      teamGoal: 'Unblock payment webhooks',
      sessionStatus: 'completed',
      participantUserId: PERSONA_OIDS.developer,
      participantStatus: 'submitted',
      structuredUpdate: {
        yesterday: 'Completed #6001 webhook signature check',
        today: 'Working on #6002 retry queue',
        blockers: 'Dev CI pipeline failing on #6002',
        handoffs: '#6001 ready for QA sign-off',
        capacity: 'Available to pair after lunch',
      },
      preparedBrief: {
        generatedAt: new Date().toISOString(),
        deliveryModel: 'flow',
        teamGoal: '[E2E] Unblock payment webhooks',
        accomplishedSinceLast: [],
        priorCommitments: [
          {
            summary: '#6002 retry queue',
            workItemIds: [6002],
            status: 'untouched',
            note: 'No ADO activity since yesterday',
          },
        ],
        suggestedToday: [],
        detectedExceptions: [
          {
            id: 'carry-6002',
            kind: 'untouched_commitment',
            severity: 'warning',
            message: 'Prior commitment untouched: #6002 retry queue',
            workItemId: 6002,
          },
        ],
        openFollowups: [],
      },
      proposals: [
        {
          workItemId: 6001,
          workItemTitle: 'Webhook signature check',
          proposalType: 'state',
          fieldName: 'state',
          currentValue: 'In PR',
          proposedValue: 'Ready for Test',
          reason: 'PR merged into main',
          confidence: 'at_risk',
        },
        {
          workItemId: 6002,
          workItemTitle: 'Retry queue worker',
          proposalType: 'state',
          fieldName: 'state',
          currentValue: 'New',
          proposedValue: 'Active',
          reason: 'Started implementation',
          confidence: 'uncertain',
        },
      ],
    });

    await loginAsPersona('developer');
    const pulsePage = new StandupPulsePage(page);
    // Navigate directly to /standup-summary WITHOUT ?session= query param
    await pulsePage.gotoSummaryNoParams();

    await expect(pulsePage.pulseDeliveryModel()).toHaveText('Flow');
    await expect(pulsePage.pulseTeamGoal()).toContainText('Unblock payment webhooks');
    await expect(pulsePage.pulseOverallHealth()).toHaveText(/At Risk|Watch/);
    await expect(pulsePage.pulseBlockersSection()).toContainText(
      'Dev CI pipeline failing on #6002',
    );
    await expect(pulsePage.pulseRisksSection()).toContainText('Carryover');

    const [firstProposal, secondProposal] = seeded.proposals;
    await page.getByTestId(`proposal-apply-btn-${firstProposal.id}`).click();
    await expect(
      page.getByTestId(`proposal-status-${firstProposal.id}`),
    ).toHaveText('applied');

    await page.getByTestId(`proposal-dismiss-btn-${secondProposal.id}`).click();
    await expect(
      page.getByTestId(`proposal-status-${secondProposal.id}`),
    ).toHaveText('dismissed');
  });

  test('4. Calendar Delivery Pulse & Confidence Filtering: filters At Risk items, shows Why at risk, and applies target-date proposal (AC-07, AC-08, AC-09)', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const freshDate = new Date().toISOString();
    const tomorrowYmd = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const proposedYmd = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const seeded = await SeedApi.seedStandupDeliveryPulse(e2eApi, {
      project: E2E_PROJECT,
      deliveryModel: 'milestone',
      goalSource: 'release_epic',
      teamGoal: 'Release v2.8 Milestone Readiness',
      sessionStatus: 'completed',
      participantUserId: PERSONA_OIDS.developer,
      participantStatus: 'submitted',
      structuredUpdate: {
        yesterday: 'Progressed #7002',
        today: 'Unblocking #7001',
        blockers: 'Waiting on schema sign-off for #7001',
      },
      proposals: [
        {
          workItemId: 7001,
          workItemTitle: 'At-Risk Milestone PBI',
          proposalType: 'target_date',
          fieldName: 'dueDate',
          currentValue: tomorrowYmd,
          proposedValue: proposedYmd,
          reason: 'Due in 2 days while still Active',
          confidence: 'at_risk',
        },
      ],
    });

    await page.route('**/api/workitems*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 7001,
            title: 'At-Risk Milestone PBI',
            state: 'Active',
            workItemType: 'Product Backlog Item',
            assignedTo: 'Dev User',
            dueDate: tomorrowYmd,
            areaPath: E2E_PROJECT,
            iterationPath: E2E_PROJECT,
            changedDate: staleDate,
            createdDate: staleDate,
          },
          {
            id: 7002,
            title: 'Healthy Completed PBI',
            state: 'Closed',
            workItemType: 'Product Backlog Item',
            assignedTo: 'Dev User',
            dueDate: tomorrowYmd,
            areaPath: E2E_PROJECT,
            iterationPath: E2E_PROJECT,
            changedDate: freshDate,
            createdDate: freshDate,
          },
        ]),
      });
    });

    await loginAsPersona('developer');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoCalendar();

    await expect(page.locator('.rbc-calendar')).toBeVisible();
    await expect(page.getByTestId('unscheduled-list')).toBeVisible();
    await expect(page.getByTestId('calendar-pulse-model')).toHaveText(
      'Milestone Pulse',
    );
    await expect(page.getByTestId('calendar-pulse-goal')).toContainText(
      'Release v2.8 Milestone Readiness',
    );

    // Filter to At Risk items
    await page.getByTestId('calendar-pulse-filter-at-risk').click();
    await expect(page.getByText(/At-Risk Milestone PBI/)).toBeVisible();
    await expect(page.getByText(/Healthy Completed PBI/)).toHaveCount(0);

    // Inspect "Why at risk?" popover on item #7001
    const confidenceBadge = page.getByTestId('work-item-confidence-7001').first();
    await expect(confidenceBadge).toBeVisible();
    await confidenceBadge.click();
    await expect(page.getByTestId('work-item-risk-reasons-7001')).toContainText(
      /Standup blocker|Unchanged in Active|Due in/i,
    );

    // Open Pending Proposals drawer and Confirm & Apply target-date proposal
    const proposal = seeded.proposals[0];
    await page.getByTestId('calendar-pulse-filter-proposals').click();
    await expect(pulsePage.calendarProposalsDrawer()).toBeVisible();
    await page.getByTestId(`calendar-proposal-apply-${proposal.id}`).click();

    await expect(
      page.getByTestId(`calendar-proposal-card-${proposal.id}`),
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.rbc-calendar')).toBeVisible();
  });
});
