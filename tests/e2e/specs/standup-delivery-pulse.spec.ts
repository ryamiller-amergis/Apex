/**
 * End-to-End Playwright coverage for Standup Delivery Pulse (SDLC-Aware, Multi-Day & Pre-Drafted).
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

test.describe('Standup Delivery Pulse (Pre-Drafted, Multi-Day & SDLC-Aware)', () => {
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

  test('1. Approve / Reject & Inline Correction Journey (/standup): reviews multi-day arc, rejects inaccurate item, submits inline correction, and reflects in Team Pulse', async ({
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
        activeWorkItems: [
          {
            id: 5002,
            title: 'Idempotent retry worker',
            workItemType: 'Task',
            state: 'Active',
            changedDate: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
        changedSinceLastWorkItems: [
          {
            id: 5001,
            title: 'Streamline webhook dispatcher',
            workItemType: 'Product Backlog Item',
            state: 'Ready for Test',
            changedDate: new Date().toISOString(),
          },
          {
            id: 5099,
            title: 'Misattributed legacy ticket',
            workItemType: 'Bug',
            state: 'Active',
            changedDate: new Date().toISOString(),
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
          {
            sessionDate: '2026-11-10',
            structuredUpdate: {
              yesterday: 'Closed #4990',
              today: '#5002 Idempotent retry worker',
            },
          },
        ],
      },
    });

    await loginAsPersona('developer');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoStandup();

    await expect(pulsePage.deliveryModelBadge()).toHaveText('Flow');
    await expect(pulsePage.teamGoalBanner()).toContainText(
      'Keep flow cycle time under 3 days',
    );
    await expect(pulsePage.multiDayArcBanner()).toContainText('#5002 (3d)');
    await expect(pulsePage.recommendedFocusBanner()).toContainText('#5002');
    // Flow mode does not nag about missing target dates
    await expect(page.getByTestId('standup-brief-exceptions')).not.toContainText(
      /no target date/i,
    );

    // Reject inaccurate item #5099
    await page
      .getByTestId('draft-item-reject-draft-yesterday-wi-5099')
      .click();

    // Enter inline user correction
    await pulsePage
      .correctionsInput()
      .fill('Also paired with QA on webhook contract smoke tests');

    // Submit standup
    await pulsePage.quickConfirmSubmitBtn().click();

    await expect(pulsePage.submittedBanner()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('standup-submitted-badge')).toHaveText(
      'Submitted',
    );

    // Navigate to Team Pulse summary and verify rejected item is excluded & correction is displayed
    await page.getByTestId('standup-view-team-pulse-btn').click();
    const devNarrative = page.getByTestId(
      `participant-narrative-${PERSONA_OIDS.developer}`,
    );
    await expect(devNarrative).toBeVisible({ timeout: 10_000 });
    await expect(devNarrative).toContainText('#5001 Streamline webhook dispatcher');
    await expect(devNarrative).not.toContainText('Misattributed legacy ticket');
    await expect(
      page.getByTestId(
        `participant-narrative-correction-${PERSONA_OIDS.developer}`,
      ),
    ).toContainText('Also paired with QA on webhook contract smoke tests');
  });

  test('2. ADO Roster Auto-Discovery & Delivery Model Config (/standup-manage): configures ADO + Groups roster discovery without target dates and persists', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
    await SeedApi.seedAdminRole(e2eApi, { userId: PERSONA_OIDS.manager });
    await SeedApi.seedStandupDeliveryPulse(e2eApi, {
      project: E2E_PROJECT,
      deliveryModel: 'flow',
      teamGoal: 'Initial Seed Config',
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

    // Verify default Participant Discovery is 'ado_and_groups' and Flow has target-date checks unchecked
    await expect(page.getByTestId('standup-config-roster-mode')).toHaveValue(
      'ado_and_groups',
    );
    await expect(page.getByTestId('standup-config-delivery-model')).toHaveValue(
      'flow',
    );
    await expect(
      page.getByTestId('standup-policy-target-date-checks'),
    ).not.toBeChecked();

    // Save config WITH ZERO groups selected (valid under ado_and_groups auto-discovery!)
    await page
      .getByTestId('standup-config-goal-source')
      .selectOption('manual');
    await page
      .getByTestId('standup-config-team-goal')
      .fill('[E2E] Auto-Discovered Flow Pulse Goal');

    await page.getByTestId('standup-config-save-btn').click();

    await expect(
      page.getByText('[E2E] Auto-Discovered Flow Pulse Goal'),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page
        .locator('[data-testid^="standup-config-card-roster-"]')
        .filter({ hasText: 'ADO + Groups' })
        .first(),
    ).toBeVisible();
  });

  test('3. SDLC Facilitator Callouts, Area Breakdown & Per-Person Narratives (/standup-summary): surfaces SQL migration, IaC pipeline alert, areas, narratives, and proposals', async ({
    page,
    loginAsPersona,
    e2eApi,
  }) => {
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
        blockers: 'Dev CI pipeline failing on #6002',
        userCorrections: 'Confirmed DBA review scheduled for 3pm EST',
      },
      participantEvidence: {
        ownerDisplayName: 'Dev User',
        activeWorkItems: [
          {
            id: 6001,
            title: 'Billing ledger SQL migration & API',
            workItemType: 'Product Backlog Item',
            state: 'In PR',
            tags: 'Release:v3.2',
            changedDate: new Date().toISOString(),
          },
        ],
        pullRequests: [
          {
            prId: 401,
            title: 'feat(billing): ledger migration & API',
            status: 'active',
            createdAt: new Date().toISOString(),
            linkedWorkItemIds: [6001],
            changedFiles: [
              'migrations/20261115_billing.sql',
              'src/server/services/billingService.ts',
              'src/server/__tests__/billingService.test.ts',
            ],
          },
        ],
      },
      additionalParticipants: [
        {
          userId: PERSONA_OIDS.qa,
          status: 'notified',
          structuredUpdate: null,
          participantEvidence: {
            ownerDisplayName: 'QA Dev User',
            activeWorkItems: [
              {
                id: 6005,
                title: 'Provision worker container autoscaling',
                workItemType: 'Technical Backlog Item',
                state: 'In PR',
                changedDate: new Date().toISOString(),
              },
            ],
            changedSinceLastWorkItems: [
              {
                id: 6004,
                title: 'Update Terraform backend variables',
                workItemType: 'Task',
                state: 'Ready for Test',
                changedDate: new Date().toISOString(),
              },
            ],
            pullRequests: [
              {
                prId: 405,
                title: 'infra: worker autoscaling terraform',
                status: 'active',
                createdAt: new Date().toISOString(),
                linkedWorkItemIds: [6005],
                changedFiles: ['infra/worker.tf'],
                builds: [
                  {
                    buildId: 8801,
                    buildNumber: '20261113.5',
                    definitionName: 'Infra-Validate',
                    status: 'completed',
                    result: 'succeeded',
                    stagesAndJobs: [
                      {
                        name: 'lint-check',
                        type: 'Stage',
                        state: 'completed',
                        result: 'succeeded',
                      },
                      {
                        name: 'terraform-plan',
                        type: 'Stage',
                        state: 'completed',
                        result: 'skipped',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
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
        {
          workItemId: 6005,
          workItemTitle: 'Provision worker container autoscaling',
          proposalType: 'state',
          fieldName: 'state',
          currentValue: 'New',
          proposedValue: 'Active',
          reason: 'Implementation in progress',
          confidence: 'uncertain',
        },
      ],
    });

    await loginAsPersona('developer');
    const pulsePage = new StandupPulsePage(page);
    await pulsePage.gotoSummaryNoParams();

    await expect(pulsePage.pulseDeliveryModel()).toHaveText('Flow');
    await expect(pulsePage.pulseTeamGoal()).toContainText(
      'Billing & Worker Infra Rollout',
    );
    await expect(pulsePage.pulseOverallHealth()).toHaveText('At Risk');

    // 1. SDLC Callouts: SQL migration + Terraform IaC skipped stage
    await expect(pulsePage.pulseSdlcCalloutsSection()).toContainText(
      'migrations/20261115_billing.sql',
    );
    await expect(pulsePage.pulseSdlcCalloutsSection()).toContainText(
      'infra/worker.tf',
    );
    await expect(pulsePage.pulseSdlcCalloutsSection()).toContainText(
      'stage "terraform-plan" was skipped',
    );

    // 2. Engineering Area Breakdown
    await expect(pulsePage.pulseAreaBreakdownSection()).toContainText(
      'Database / SQL',
    );
    await expect(pulsePage.pulseAreaBreakdownSection()).toContainText(
      'Infra / Terraform',
    );

    // 3. Per-person multi-day narratives: Confirmed (with correction) AND AI-Drafted from ADO
    await expect(
      page.getByTestId(
        `participant-narrative-status-${PERSONA_OIDS.developer}`,
      ),
    ).toHaveText('Confirmed');
    await expect(
      page.getByTestId(
        `participant-narrative-correction-${PERSONA_OIDS.developer}`,
      ),
    ).toContainText('Confirmed DBA review scheduled for 3pm EST');

    await expect(
      page.getByTestId(`participant-narrative-status-${PERSONA_OIDS.qa}`),
    ).toHaveText('AI-Drafted from ADO');
    await expect(
      page.getByTestId(`participant-narrative-${PERSONA_OIDS.qa}`),
    ).toContainText('IaC Pipeline Verification Alert');

    // 4. Confirmation-gated ADO proposals apply & dismiss
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
});
