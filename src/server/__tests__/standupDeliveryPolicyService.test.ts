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
  evaluateCalendarItemHealth,
  evaluateParticipantBrief,
  formatPreparedBriefForPrompt,
  resolveStandupPolicy,
  synthesizeTeamPulse,
} from '../services/standupDeliveryPolicyService';

const FIXED_NOW = '2026-11-13T14:00:00.000Z';

describe('resolveStandupPolicy (AC-01)', () => {
  it('defaults flow, sprint, support, and custom to enableTargetDateChecks=false and milestone to true', () => {
    expect(resolveStandupPolicy('flow')).toMatchObject({
      staleDaysThreshold: 3,
      prReviewWaitHours: 24,
      wipLimitPerPerson: 3,
      slaHoursHighPriority: null,
      enableTargetDateChecks: false,
    });

    expect(resolveStandupPolicy('sprint')).toMatchObject({
      wipLimitPerPerson: null,
      enableTargetDateChecks: false,
    });

    expect(resolveStandupPolicy('support')).toMatchObject({
      slaHoursHighPriority: 24,
      enableTargetDateChecks: false,
    });

    expect(resolveStandupPolicy('custom')).toMatchObject({
      enableTargetDateChecks: false,
    });

    expect(resolveStandupPolicy('milestone')).toMatchObject({
      enableTargetDateChecks: true,
    });
  });

  it('respects explicit policy overrides on any model', () => {
    const custom = resolveStandupPolicy('flow', {
      staleDaysThreshold: 5,
      wipLimitPerPerson: 2,
      enableTargetDateChecks: true,
    });
    expect(custom.staleDaysThreshold).toBe(5);
    expect(custom.wipLimitPerPerson).toBe(2);
    expect(custom.enableTargetDateChecks).toBe(true);
  });
});

describe('evaluateParticipantBrief (AC-01, AC-02, AC-04)', () => {
  it('detects untouched commitments, PR merge state lag, PR review wait, WIP overload, and stale states in flow mode WITHOUT missing-target-date alerts', () => {
    const brief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      teamGoal: 'Keep cycle time under 3 days',
      activeWorkItems: [
        {
          id: 101,
          title: 'Auth token refresh',
          workItemType: 'Product Backlog Item',
          state: 'In PR',
          changedDate: '2026-11-08T10:00:00.000Z',
          targetDate: null,
        },
        {
          id: 102,
          title: 'Audit logging',
          workItemType: 'Task',
          state: 'Active',
          changedDate: '2026-11-12T18:00:00.000Z',
          targetDate: null,
        },
        {
          id: 103,
          title: 'Rate limiter',
          workItemType: 'Task',
          state: 'Active',
          changedDate: '2026-11-12T18:00:00.000Z',
          targetDate: null,
        },
        {
          id: 104,
          title: 'Webhook retry',
          workItemType: 'Bug',
          state: 'Active',
          changedDate: '2026-11-12T18:00:00.000Z',
          targetDate: null,
        },
      ],
      changedSinceLastWorkItems: [
        {
          id: 102,
          title: 'Audit logging',
          workItemType: 'Task',
          state: 'Active',
          changedDate: '2026-11-12T18:00:00.000Z',
        },
      ],
      pullRequests: [
        {
          prId: 55,
          title: 'Merge auth token refresh',
          status: 'completed',
          createdAt: '2026-11-12T08:00:00.000Z',
          linkedWorkItemIds: [101],
        },
        {
          prId: 56,
          title: 'Add rate limiter middleware',
          status: 'active',
          createdAt: '2026-11-11T10:00:00.000Z',
          linkedWorkItemIds: [103],
          hasApproval: false,
        },
      ],
      pipelineFailures: [
        {
          buildId: 900,
          buildNumber: '20261113.2',
          definitionName: 'CI-Main',
          branch: 'refs/heads/main',
          failedAt: '2026-11-13T09:00:00.000Z',
          linkedWorkItemIds: [103],
        },
      ],
      priorStructuredUpdate: {
        today: '#101 Auth token refresh; #102 Audit logging; #104 Webhook retry',
      },
      openFollowups: [
        { id: 'f-1', title: 'Sync on auth contract', sessionDate: '2026-11-12' },
      ],
    });

    expect(brief.deliveryModel).toBe('flow');
    expect(brief.teamGoal).toBe('Keep cycle time under 3 days');
    expect(brief.openFollowups).toHaveLength(1);

    // Commitment memory classification
    expect(brief.priorCommitments).toEqual([
      expect.objectContaining({ workItemIds: [101], status: 'completed' }),
      expect.objectContaining({ workItemIds: [102], status: 'progressed' }),
      expect.objectContaining({ workItemIds: [104], status: 'untouched' }),
    ]);

    const kinds = brief.detectedExceptions.map((e) => e.kind);
    expect(kinds).toContain('untouched_commitment');
    expect(kinds).toContain('pr_merged_state_lag');
    expect(kinds).toContain('pr_waiting_review');
    expect(kinds).toContain('pipeline_failure');
    expect(kinds).toContain('wip_overload');
    expect(kinds).toContain('stale_state');
    // Crucial: Flow mode never nags about missing target dates by default
    expect(kinds).not.toContain('missing_target_date');
    expect(kinds).not.toContain('target_date_at_risk');

    const lagEx = brief.detectedExceptions.find(
      (e) => e.kind === 'pr_merged_state_lag',
    );
    expect(lagEx?.proposedAction).toMatchObject({
      proposalType: 'state',
      fieldName: 'state',
      proposedValue: 'Ready for Test',
    });
  });

  it('flags missing_target_date and target_date_at_risk with date proposals in milestone mode (AC-04)', () => {
    const brief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'milestone',
      teamGoal: 'Release v2.4 readiness',
      activeWorkItems: [
        {
          id: 201,
          title: 'Release feature missing target date',
          workItemType: 'Feature',
          state: 'Active',
          changedDate: '2026-11-13T10:00:00.000Z',
          targetDate: null,
          tags: 'Release:v2.4',
        },
        {
          id: 202,
          title: 'Near-due PBI still Active',
          workItemType: 'Product Backlog Item',
          state: 'Active',
          changedDate: '2026-11-13T10:00:00.000Z',
          dueDate: '2026-11-16',
        },
      ],
    });

    const missingEx = brief.detectedExceptions.find(
      (e) => e.kind === 'missing_target_date' && e.workItemId === 201,
    );
    expect(missingEx).toBeDefined();
    expect(missingEx?.proposedAction).toMatchObject({
      proposalType: 'target_date',
      fieldName: 'targetDate',
      proposedValue: '2026-11-20',
    });

    const atRiskEx = brief.detectedExceptions.find(
      (e) => e.kind === 'target_date_at_risk' && e.workItemId === 202,
    );
    expect(atRiskEx).toBeDefined();
    expect(atRiskEx?.proposedAction).toMatchObject({
      proposalType: 'target_date',
      fieldName: 'dueDate',
      currentValue: '2026-11-16',
      proposedValue: '2026-11-23',
    });
  });

  it('flags sla_breach in support mode and sprint mismatch in sprint mode without target-date errors', () => {
    const supportBrief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'support',
      activeWorkItems: [
        {
          id: 301,
          title: 'Prod login 500 spike',
          workItemType: 'Bug',
          state: 'Active',
          createdDate: '2026-11-11T10:00:00.000Z',
          changedDate: '2026-11-13T12:00:00.000Z',
          priority: 1,
        },
      ],
    });
    expect(supportBrief.detectedExceptions.map((e) => e.kind)).toContain(
      'sla_breach',
    );
    expect(supportBrief.detectedExceptions.map((e) => e.kind)).not.toContain(
      'missing_target_date',
    );

    const sprintBrief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'sprint',
      expectedIterationPath: 'MaxView\\Sprint 42',
      activeWorkItems: [
        {
          id: 302,
          title: 'Backlog item in wrong iteration',
          workItemType: 'Product Backlog Item',
          state: 'Active',
          iterationPath: 'MaxView\\Sprint 41',
          changedDate: '2026-11-13T12:00:00.000Z',
        },
      ],
    });
    expect(sprintBrief.suggestedToday[0].riskFlags).toContain('Outside sprint');
    expect(sprintBrief.detectedExceptions.map((e) => e.kind)).not.toContain(
      'missing_target_date',
    );

    const formatted = formatPreparedBriefForPrompt(supportBrief);
    expect(formatted).toContain('Delivery Model: support');
    expect(formatted).toContain('sla_breach');
  });
});

describe('synthesizeTeamPulse & evaluateCalendarItemHealth (AC-06, AC-07)', () => {
  it('synthesizes blockers, carryover alerts, at-risk items, capacity, and proposals into StandupTeamPulse', () => {
    const brief = evaluateParticipantBrief({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      teamGoal: 'Stabilize checkout flow',
      activeWorkItems: [
        {
          id: 401,
          title: 'Checkout retry handler',
          workItemType: 'Product Backlog Item',
          state: 'Active',
          changedDate: '2026-11-05T10:00:00.000Z',
        },
      ],
      priorStructuredUpdate: { today: '#401 Checkout retry handler' },
    });

    const pulse = synthesizeTeamPulse({
      now: FIXED_NOW,
      deliveryModel: 'flow',
      teamGoal: 'Stabilize checkout flow',
      participants: [
        {
          userId: 'dev-1',
          displayName: 'Dev One',
          status: 'submitted',
          structuredUpdate: {
            yesterday: 'Shipped #400 payment logging',
            today: 'Finishing #401',
            blockers: 'Staging deploy pipeline failing on #401',
            handoffs: '#400 ready for QA verification',
            capacity: 'Available to pair after 2pm',
          },
          preparedBrief: brief,
        },
      ],
      proposals: [
        {
          id: 'prop-1',
          sessionId: 'sess-1',
          participantId: 'part-1',
          project: 'MaxView',
          workItemId: 401,
          workItemTitle: 'Checkout retry handler',
          proposalType: 'state',
          fieldName: 'state',
          currentValue: 'In PR',
          proposedValue: 'Ready for Test',
          reason: 'PR merged',
          confidence: 'at_risk',
          status: 'pending',
          decidedBy: null,
          decidedAt: null,
          createdAt: FIXED_NOW,
        },
      ],
    });

    expect(pulse.overallHealth).toBe('at_risk');
    expect(pulse.blockers[0]).toMatchObject({
      blockerType: 'pipeline',
      ownerDisplayName: 'Dev One',
      workItemIds: [401],
    });
    expect(pulse.carryoverAlerts).toHaveLength(1);
    expect(pulse.handoffsAndReviews).toHaveLength(1);
    expect(pulse.capacityNotes).toHaveLength(1);
    expect(pulse.decisionsNeeded.some((d) => d.includes('staged ADO update proposal'))).toBe(
      true,
    );

    // Evaluate calendar item health in Flow vs Milestone
    const flowCal = evaluateCalendarItemHealth(
      [
        {
          id: 401,
          title: 'Checkout retry handler',
          workItemType: 'Product Backlog Item',
          state: 'Active',
          changedDate: '2026-11-05T10:00:00.000Z',
          dueDate: null,
        },
        {
          id: 402,
          title: 'Healthy unscheduled Flow item',
          workItemType: 'Product Backlog Item',
          state: 'Active',
          changedDate: '2026-11-13T10:00:00.000Z',
          dueDate: null,
        },
      ],
      {
        now: FIXED_NOW,
        deliveryModel: 'flow',
        teamPulse: pulse,
      },
    );

    expect(flowCal.itemHealthById[401].confidence).toBe('at_risk');
    expect(flowCal.itemHealthById[401].isBlockedOrStale).toBe(true);
    expect(flowCal.itemHealthById[402].confidence).toBe('on_track');
    expect(flowCal.counts.missingTargetDate).toBe(0);

    const milestoneCal = evaluateCalendarItemHealth(
      [
        {
          id: 402,
          title: 'Unscheduled Milestone Feature',
          workItemType: 'Feature',
          state: 'Active',
          changedDate: '2026-11-13T10:00:00.000Z',
          targetDate: null,
        },
      ],
      {
        now: FIXED_NOW,
        deliveryModel: 'milestone',
      },
    );
    expect(milestoneCal.counts.missingTargetDate).toBe(1);
    expect(milestoneCal.itemHealthById[402].confidence).toBe('at_risk');
    expect(milestoneCal.itemHealthById[402].reasons[0]).toMatch(/Missing target\/due date/);
  });
});

describe('Policy-driven AI Prompts (AC-05)', () => {
  it('adapts participant and facilitator prompts dynamically to flow vs milestone models', () => {
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

    expect(flowPrompt).toContain('deliveryModel:          "flow"');
    expect(flowPrompt).toContain('Reduce PR cycle time');
    expect(flowPrompt).toContain('Target-date checks are DISABLED');
    expect(flowPrompt).not.toContain('NEVER mention sprints');

    const milestonePrompt = buildStandupParticipantPrompt({
      project: 'MaxView',
      repo: '',
      mode: 'standup-participant',
      standupSessionId: 's-2',
      standupParticipantId: 'p-2',
      standupDeliveryModel: 'milestone',
      standupTeamGoal: 'Ship v3.0 by Nov 30',
      standupUserEmail: 'dev@localhost',
    });

    expect(milestonePrompt).toContain('deliveryModel:          "milestone"');
    expect(milestonePrompt).toContain('Target-date checks are ENABLED');
    expect(milestonePrompt).toContain('ReleaseVersion');

    const facilitatorPrompt = buildStandupFacilitatorPrompt({
      project: 'MaxView',
      repo: '',
      mode: 'standup-facilitator',
      standupSessionId: 's-1',
      standupDeliveryModel: 'sprint',
      standupTeamGoal: 'Complete Sprint 18 checkout stories',
    });
    expect(facilitatorPrompt).toContain('deliveryModel:          "sprint"');
    expect(facilitatorPrompt).toContain('Complete Sprint 18 checkout stories');
    expect(facilitatorPrompt).toContain('do NOT invent missing-target-date warnings');
  });
});
