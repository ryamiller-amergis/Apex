jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      standupSessions: { findFirst: jest.fn() },
      standupActionProposals: { findMany: jest.fn().mockResolvedValue([]) },
      appUsers: { findMany: jest.fn().mockResolvedValue([]) },
    },
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
    })),
  },
}));

import {
  buildStandupFacilitatorPrompt,
  buildStandupParticipantPrompt,
  classifyDomainsFromEvidence,
  evaluateParticipantBrief,
  evaluateSdlcCallouts,
  formatPreparedBriefForPrompt,
  normalizeRosterMode,
  reconcileDraftedUpdate,
  resolveStandupPolicy,
  synthesizeTeamPulse,
} from '../services/standupDeliveryPolicyService';

const FIXED_NOW = '2026-11-13T14:00:00.000Z';

describe('resolveStandupPolicy & normalizeRosterMode (AC-01)', () => {
  it('defaults flow, sprint, support, and custom to enableTargetDateChecks=false and milestone to true', () => {
    expect(resolveStandupPolicy('flow')).toMatchObject({
      staleDaysThreshold: 3,
      prReviewWaitHours: 24,
      wipLimitPerPerson: 3,
      slaHoursHighPriority: null,
      enableTargetDateChecks: false,
    });
    expect(resolveStandupPolicy('sprint').enableTargetDateChecks).toBe(false);
    expect(resolveStandupPolicy('support')).toMatchObject({
      slaHoursHighPriority: 24,
      enableTargetDateChecks: false,
    });
    expect(resolveStandupPolicy('custom').enableTargetDateChecks).toBe(false);
    expect(resolveStandupPolicy('milestone').enableTargetDateChecks).toBe(true);
  });

  it('normalizes rosterMode defaulting to ado_and_groups', () => {
    expect(normalizeRosterMode(undefined)).toBe('ado_and_groups');
    expect(normalizeRosterMode('invalid')).toBe('ado_and_groups');
    expect(normalizeRosterMode('ado_active')).toBe('ado_active');
    expect(normalizeRosterMode('groups_only')).toBe('groups_only');
  });
});

describe('Multi-day history, carryover streaks & pre-drafted Approve/Reject reconciliation (AC-02, AC-03)', () => {
  it('computes multi-day carryover streaks across prior standups and drafts yesterday/today/blocker items', () => {
    const brief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      teamGoal: 'Keep cycle time under 3 days',
      activeWorkItems: [
        {
          id: 1042,
          title: 'Webhook retry worker',
          workItemType: 'Task',
          state: 'Active',
          changedDate: '2026-11-09T10:00:00.000Z',
        },
        {
          id: 1050,
          title: 'Billing API endpoint',
          workItemType: 'Product Backlog Item',
          state: 'Active',
          changedDate: '2026-11-13T10:00:00.000Z',
        },
      ],
      changedSinceLastWorkItems: [
        {
          id: 1040,
          title: 'Schema audit helper',
          workItemType: 'Task',
          state: 'Ready for Test',
          changedDate: '2026-11-12T18:00:00.000Z',
        },
        {
          id: 1099,
          title: 'Misattributed legacy item',
          workItemType: 'Bug',
          state: 'Active',
          changedDate: '2026-11-12T19:00:00.000Z',
        },
      ],
      priorHistory: [
        {
          sessionDate: '2026-11-12',
          structuredUpdate: {
            yesterday: 'Started #1040',
            today: '#1042 Webhook retry worker; #1040 Schema audit helper',
            userCorrections: 'Waiting on staging Redis credentials',
          },
        },
        {
          sessionDate: '2026-11-11',
          structuredUpdate: {
            yesterday: 'Scoped #1042',
            today: '#1042 Webhook retry worker',
          },
        },
        {
          sessionDate: '2026-11-10',
          structuredUpdate: {
            yesterday: 'Closed #1038',
            today: '#1042 Webhook retry worker',
          },
        },
      ],
    });

    expect(brief.multiDayArc?.sessionsAnalyzed).toBe(3);
    expect(brief.multiDayArc?.carryoverStreaks).toEqual([
      expect.objectContaining({
        workItemId: 1042,
        title: 'Webhook retry worker',
        daysCarried: 3,
      }),
    ]);
    expect(brief.multiDayArc?.summary).toContain('#1042 (3d)');
    expect(brief.multiDayArc?.summary).toContain('Waiting on staging Redis credentials');
    expect(brief.recommendedFocus).toContain('#1042');

    const drafted = brief.draftedItems ?? [];
    expect(drafted.some((i) => i.id === 'draft-yesterday-wi-1040')).toBe(true);
    expect(drafted.some((i) => i.id === 'draft-yesterday-wi-1099')).toBe(true);
    expect(drafted.some((i) => i.id === 'draft-today-wi-1042')).toBe(true);

    // Reject #1099 and add a user correction
    const reconciled = reconcileDraftedUpdate({
      draftedItems: drafted,
      itemDecisions: {
        'draft-yesterday-wi-1040': 'approved',
        'draft-yesterday-wi-1099': 'rejected',
        'draft-today-wi-1042': 'approved',
        'draft-today-wi-1050': 'approved',
      },
      rejectionReasons: {
        'draft-yesterday-wi-1099': 'Only reassigned ticket, did not implement',
      },
      userCorrections: 'Also paired with QA on billing smoke suite',
    });

    expect(reconciled.approvalAction).toBe('approved_with_edits');
    expect(reconciled.yesterday).toContain('#1040');
    expect(reconciled.yesterday).not.toContain('#1099');
    expect(reconciled.today).toContain('Also paired with QA on billing smoke suite');
    expect(reconciled.userCorrections).toBe(
      'Also paired with QA on billing smoke suite',
    );
    expect(reconciled.rejectedItems).toEqual([
      expect.objectContaining({
        id: 'draft-yesterday-wi-1099',
        reason: 'Only reassigned ticket, did not implement',
      }),
    ]);
  });
});

describe('Domain Categorization & SDLC Process Evaluators (AC-04)', () => {
  it('classifies database, iac, backend, frontend, qa, security, and prod_support domains accurately', () => {
    const domains = classifyDomainsFromEvidence(
      [
        {
          id: 1,
          title: 'Sev1 outage on auth login',
          workItemType: 'Bug',
          state: 'Active',
          priority: 1,
        },
        {
          id: 2,
          title: 'RBAC permission guard',
          workItemType: 'Task',
          state: 'Active',
        },
      ],
      [
        {
          prId: 10,
          title: 'Add billing migration and worker',
          status: 'active',
          createdAt: FIXED_NOW,
          linkedWorkItemIds: [2],
          changedFiles: [
            'migrations/20261115_billing.sql',
            'infra/worker.tf',
            'src/server/services/billingService.ts',
            'src/client/components/BillingView.tsx',
            'tests/e2e/specs/billing.spec.ts',
          ],
        },
      ],
    );

    expect(domains).toEqual(
      expect.arrayContaining([
        'database',
        'iac',
        'prod_support',
        'security',
        'backend',
        'frontend',
        'qa',
      ]),
    );
  });

  it('flags sql_migration, iac_pipeline (when skipped/failed/missing), missing_tests, red_build_in_qa, and pr_state_drift', () => {
    const callouts = evaluateSdlcCallouts({
      ownerDisplayName: 'Alice Dev',
      activeWorkItems: [
        {
          id: 801,
          title: 'Billing ledger rollout',
          workItemType: 'Feature',
          state: 'Ready for Release',
          tags: 'Release:v3.1',
        },
        {
          id: 802,
          title: 'Worker autoscaling infra',
          workItemType: 'Technical Backlog Item',
          state: 'In PR',
        },
        {
          id: 803,
          title: 'QA checkout verification',
          workItemType: 'Product Backlog Item',
          state: 'Ready for Test',
        },
        {
          id: 804,
          title: 'Merged API endpoint still Active',
          workItemType: 'Task',
          state: 'Active',
        },
      ],
      pullRequests: [
        {
          prId: 201,
          title: 'feat: billing schema migration + service',
          status: 'active',
          createdAt: FIXED_NOW,
          linkedWorkItemIds: [801],
          changedFiles: [
            'migrations/20261115_billing.sql',
            'src/server/services/billingLedger.ts',
          ],
        },
        {
          prId: 202,
          title: 'chore(infra): update worker container replicas',
          status: 'active',
          createdAt: FIXED_NOW,
          linkedWorkItemIds: [802],
          changedFiles: ['infra/worker.tf'],
          builds: [
            {
              buildId: 9001,
              buildNumber: '20261113.4',
              definitionName: 'PR-Validation',
              status: 'completed',
              result: 'succeeded',
              stagesAndJobs: [
                { name: 'lint-and-unit', type: 'Stage', state: 'completed', result: 'succeeded' },
                { name: 'terraform-plan', type: 'Stage', state: 'completed', result: 'skipped' },
              ],
            },
          ],
        },
        {
          prId: 204,
          title: 'feat: merged endpoint',
          status: 'completed',
          createdAt: FIXED_NOW,
          linkedWorkItemIds: [804],
          changedFiles: ['src/server/routes/health.ts', 'src/server/__tests__/health.test.ts'],
        },
      ],
      pipelineFailures: [
        {
          buildId: 9009,
          buildNumber: '20261113.8',
          definitionName: 'Integration-CI',
          failedAt: FIXED_NOW,
          linkedWorkItemIds: [803],
        },
      ],
    });

    const categories = callouts.map((c) => c.category);
    expect(categories).toContain('sql_migration');
    expect(categories).toContain('iac_pipeline');
    expect(categories).toContain('missing_tests');
    expect(categories).toContain('red_build_in_qa');
    expect(categories).toContain('pr_state_drift');

    const iacAlert = callouts.find((c) => c.category === 'iac_pipeline');
    expect(iacAlert?.detail).toContain('infra/worker.tf');
    expect(iacAlert?.detail).toContain('stage "terraform-plan" was skipped');
  });

  it('does NOT emit iac_pipeline alert when Terraform stage succeeded', () => {
    const callouts = evaluateSdlcCallouts({
      activeWorkItems: [
        { id: 810, title: 'Infra update', workItemType: 'Task', state: 'In PR' },
      ],
      pullRequests: [
        {
          prId: 210,
          title: 'infra: valid tf plan',
          status: 'active',
          createdAt: FIXED_NOW,
          linkedWorkItemIds: [810],
          changedFiles: ['infra/main.tf'],
          builds: [
            {
              buildId: 9020,
              buildNumber: '20261113.9',
              definitionName: 'Infra-CI',
              status: 'completed',
              result: 'succeeded',
              stagesAndJobs: [
                { name: 'terraform-validate-and-plan', type: 'Stage', state: 'completed', result: 'succeeded' },
              ],
            },
          ],
        },
      ],
    });

    expect(callouts.find((c) => c.category === 'iac_pipeline')).toBeUndefined();
  });
});

describe('synthesizeTeamPulse: SDLC callouts, Area Breakdown & Individual Narratives (AC-06)', () => {
  it('generates confirmed narratives (with userCorrections) AND ai_drafted narratives for unsubmitted teammates', () => {
    const aliceBrief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      ownerDisplayName: 'Alice',
      activeWorkItems: [
        {
          id: 901,
          title: 'Add billing SQL migration',
          workItemType: 'Task',
          state: 'In PR',
          changedDate: FIXED_NOW,
        },
      ],
      pullRequests: [
        {
          prId: 301,
          title: 'feat(db): billing table migration',
          status: 'active',
          createdAt: FIXED_NOW,
          linkedWorkItemIds: [901],
          changedFiles: [
            'migrations/20261115_billing.sql',
            'tests/integration/billing.test.ts',
          ],
        },
      ],
    });

    const bobBrief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      ownerDisplayName: 'Bob',
      activeWorkItems: [
        {
          id: 902,
          title: 'Provision worker Service Bus queue',
          workItemType: 'Technical Backlog Item',
          state: 'In PR',
          changedDate: FIXED_NOW,
        },
      ],
      changedSinceLastWorkItems: [
        {
          id: 900,
          title: 'Terraform state backend setup',
          workItemType: 'Task',
          state: 'Ready for Test',
          changedDate: FIXED_NOW,
        },
      ],
      pullRequests: [
        {
          prId: 302,
          title: 'infra: service bus queue',
          status: 'active',
          createdAt: FIXED_NOW,
          linkedWorkItemIds: [902],
          changedFiles: ['infra/shared-async.tf'],
          builds: [],
        },
      ],
    });

    const pulse = synthesizeTeamPulse({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      teamGoal: 'Safe billing v3 rollout',
      participants: [
        {
          userId: 'u-alice',
          displayName: 'Alice',
          status: 'submitted',
          structuredUpdate: {
            yesterday: 'Drafted #901 billing migration',
            today: 'Verifying rollback script on staging',
            blockers: '',
            userCorrections: 'Coordinated DBA maintenance window at 4pm EST',
          },
          preparedBrief: aliceBrief,
        },
        {
          userId: 'u-bob',
          displayName: 'Bob',
          status: 'notified',
          structuredUpdate: null,
          preparedBrief: bobBrief,
        },
      ],
    });

    expect(pulse.sdlcCallouts?.map((c) => c.category)).toEqual(
      expect.arrayContaining(['sql_migration', 'iac_pipeline']),
    );

    const areaDomains = pulse.areaBreakdown?.map((a) => a.domain) ?? [];
    expect(areaDomains).toEqual(expect.arrayContaining(['database', 'iac']));

    const narratives = pulse.individualNarratives ?? [];
    expect(narratives).toHaveLength(2);

    const aliceNarrative = narratives.find((n) => n.userId === 'u-alice');
    expect(aliceNarrative).toMatchObject({
      status: 'confirmed',
      userCorrections: 'Coordinated DBA maintenance window at 4pm EST',
    });

    const bobNarrative = narratives.find((n) => n.userId === 'u-bob');
    expect(bobNarrative).toMatchObject({
      status: 'ai_drafted',
    });
    expect(bobNarrative?.yesterdaySummary).toContain('#900');
    expect(bobNarrative?.todayFocus).toContain('IaC Pipeline Verification Alert');

    const promptBrief = formatPreparedBriefForPrompt(bobBrief);
    expect(promptBrief).toContain('Infra / Terraform');
    expect(promptBrief).toContain('iac_pipeline');
  });
});

describe('Policy & SDLC AI Prompts (AC-05)', () => {
  it('includes SDLC verification and multi-day narrative instructions while adapting to deliveryModel', () => {
    const flowPrompt = buildStandupParticipantPrompt({
      project: 'MaxView',
      repo: '',
      mode: 'standup-participant',
      standupSessionId: 's-1',
      standupParticipantId: 'p-1',
      standupDeliveryModel: 'flow',
      standupTeamGoal: 'Reduce PR cycle time',
      standupUserEmail: 'dev@localhost',
    });
    expect(flowPrompt).toContain('Target-date checks are DISABLED');
    expect(flowPrompt).toContain('SDLC Artifact Checks');
    expect(flowPrompt).toContain('userCorrections');

    const facilitatorPrompt = buildStandupFacilitatorPrompt({
      project: 'MaxView',
      repo: '',
      mode: 'standup-facilitator',
      standupSessionId: 's-1',
      standupDeliveryModel: 'flow',
      standupTeamGoal: 'Safe release promotion',
    });
    expect(facilitatorPrompt).toContain('SDLC & Release Process Callouts');
    expect(facilitatorPrompt).toContain('Engineering Area Breakdown');
    expect(facilitatorPrompt).toContain('Individual Standup Narratives');
  });
});

describe('Strict Ownership Attribution, Item Caps & Generic No-ADO Standup', () => {
  it('excludes items and PRs owned by another teammate from preselected draft and caps personal buckets at 3', () => {
    const brief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      ownerDisplayName: 'Ryan Miller',
      ownerEmail: 'ryan@amergis.com',
      activeWorkItems: [
        { id: 1, title: 'Owned task 1', workItemType: 'Task', state: 'Active', assignedToEmail: 'ryan@amergis.com' },
        { id: 2, title: 'Owned task 2', workItemType: 'Task', state: 'Active', assignedToEmail: 'ryan@amergis.com' },
        { id: 3, title: 'Owned task 3', workItemType: 'Task', state: 'Active', assignedToEmail: 'ryan@amergis.com' },
        { id: 4, title: 'Owned task 4 overflow', workItemType: 'Task', state: 'Active', assignedToEmail: 'ryan@amergis.com' },
        { id: 99, title: 'Teammate task', workItemType: 'Task', state: 'Active', assignedTo: 'Alex Rivera', assignedToEmail: 'alex@amergis.com' },
      ],
      changedSinceLastWorkItems: [
        { id: 10, title: 'Owned finished item', workItemType: 'Bug', state: 'Ready for Test', assignedToEmail: 'ryan@amergis.com' },
        { id: 88, title: 'Teammate bug triaged by Ryan', workItemType: 'Bug', state: 'Active', assignedTo: 'Alex Rivera', assignedToEmail: 'alex@amergis.com' },
      ],
      pullRequests: [
        {
          prId: 500,
          title: 'Alex PR reviewed by Ryan',
          status: 'completed',
          createdAt: FIXED_NOW,
          authorEmail: 'alex@amergis.com',
          linkedWorkItemIds: [88],
        },
      ],
    });

    const yesterdayDraft = (brief.draftedItems ?? []).filter((i) => i.bucket === 'yesterday');
    const todayDraft = (brief.draftedItems ?? []).filter((i) => i.bucket === 'today');

    expect(yesterdayDraft.map((i) => i.workItemId)).toEqual([10]);
    expect(todayDraft).toHaveLength(3);
    expect(todayDraft.map((i) => i.workItemId)).not.toContain(99);
    expect(todayDraft.map((i) => i.workItemId)).not.toContain(4);

    const suggestedIds = (brief.suggestedActivity ?? []).map((s) => s.id);
    expect(suggestedIds).toEqual(
      expect.arrayContaining([
        'suggested-wi-99',
        'suggested-wi-88',
        'suggested-pr-500',
        'suggested-today-wi-4',
      ]),
    );
  });

  it('produces contextual AI check-in questions and Scrum Master prompts when no ADO evidence exists', () => {
    const noAdoBrief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      teamGoal: 'Complete Q4 customer onboarding',
      activeWorkItems: [],
      priorHistory: [
        {
          sessionDate: '2026-11-12',
          structuredUpdate: {
            yesterday: 'Drafted onboarding guide',
            today: 'Review onboarding guide with support',
            blockers: 'Waiting on updated screenshots',
          },
        },
      ],
    });

    expect(noAdoBrief.hasExternalEvidence).toBe(false);
    expect(noAdoBrief.proposedQuestions?.join(' ')).toContain(
      'Waiting on updated screenshots',
    );
    expect(noAdoBrief.proposedQuestions?.join(' ')).toContain(
      'Review onboarding guide with support',
    );

    const pulse = synthesizeTeamPulse({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      teamGoal: 'Complete Q4 customer onboarding',
      participants: [
        {
          userId: 'u-1',
          displayName: 'Sam',
          status: 'submitted',
          structuredUpdate: {
            yesterday: 'Finished onboarding guide review',
            today: 'Publish help center article',
            blockers: 'Need CMS publish permission',
          },
          preparedBrief: noAdoBrief,
        },
        {
          userId: 'u-2',
          displayName: 'Taylor',
          status: 'notified',
          structuredUpdate: null,
          preparedBrief: evaluateParticipantBrief({
            now: FIXED_NOW,
            activeWorkItems: [],
          }),
        },
      ],
    });

    expect(pulse.goalProgressSummary).toContain('1 of 2 checked in');
    expect(pulse.goalProgressSummary).not.toContain('SDLC');
    expect(pulse.facilitatorPrompts?.join(' ')).toContain('Need CMS publish permission');
    expect(pulse.facilitatorPrompts?.join(' ')).toContain('Taylor');
  });
});
