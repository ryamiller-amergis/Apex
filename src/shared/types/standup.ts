export type StandupDeliveryModel = 'flow' | 'sprint' | 'milestone' | 'support' | 'custom';

export const STANDUP_DELIVERY_MODELS: readonly StandupDeliveryModel[] = [
  'flow',
  'sprint',
  'milestone',
  'support',
  'custom',
] as const;

export const STANDUP_DELIVERY_MODEL_LABELS: Record<StandupDeliveryModel, string> = {
  flow: 'Flow',
  sprint: 'Sprint',
  milestone: 'Milestone',
  support: 'Support',
  custom: 'Custom',
};

export type StandupGoalSource =
  | 'none'
  | 'manual'
  | 'iteration'
  | 'release_epic'
  | 'saved_query';

export const STANDUP_GOAL_SOURCES: readonly StandupGoalSource[] = [
  'none',
  'manual',
  'iteration',
  'release_epic',
  'saved_query',
] as const;

export interface StandupDeliveryPolicy {
  staleDaysThreshold: number;
  prReviewWaitHours: number;
  wipLimitPerPerson: number | null;
  slaHoursHighPriority: number | null;
  enablePrEvidence: boolean;
  enablePipelineEvidence: boolean;
  enableCommitmentMemory: boolean;
  enableTargetDateChecks: boolean;
  stateVocabulary?: string[];
}

export interface StandupStructuredUpdate {
  yesterday?: string;
  today?: string;
  blockers?: string;
  atRisk?: string;
  handoffs?: string;
  capacity?: string;
}

export type StandupProposalType = 'target_date' | 'state' | 'assigned_to';
export type StandupConfidence = 'on_track' | 'uncertain' | 'at_risk';
export type StandupOverallHealth = 'on_track' | 'watch' | 'at_risk';

export type StandupExceptionKind =
  | 'stale_state'
  | 'pr_merged_state_lag'
  | 'pr_waiting_review'
  | 'pipeline_failure'
  | 'untouched_commitment'
  | 'missing_target_date'
  | 'target_date_at_risk'
  | 'wip_overload'
  | 'sla_breach';

export interface StandupProposedAction {
  proposalType: StandupProposalType;
  fieldName: string;
  currentValue?: string | null;
  proposedValue: string;
  label: string;
}

export interface ParticipantDetectedException {
  id: string;
  kind: StandupExceptionKind;
  severity: 'warning' | 'critical';
  message: string;
  workItemId?: number;
  workItemTitle?: string;
  prId?: number;
  proposedAction?: StandupProposedAction;
}

export interface ParticipantPreparedBrief {
  generatedAt: string;
  deliveryModel: StandupDeliveryModel;
  teamGoal: string | null;
  accomplishedSinceLast: Array<{
    workItemId?: number;
    prId?: number;
    title: string;
    workItemType?: string;
    state?: string;
    evidence: string;
  }>;
  priorCommitments: Array<{
    summary: string;
    workItemIds: number[];
    status: 'completed' | 'progressed' | 'untouched';
    note: string;
  }>;
  suggestedToday: Array<{
    workItemId: number;
    title: string;
    workItemType: string;
    state: string;
    targetDate?: string | null;
    iterationPath?: string | null;
    riskFlags: string[];
  }>;
  detectedExceptions: ParticipantDetectedException[];
  openFollowups: Array<{
    id: string;
    title: string;
    sessionDate: string;
  }>;
}

export interface StandupTeamPulse {
  generatedAt: string;
  deliveryModel: StandupDeliveryModel;
  teamGoal: string | null;
  goalProgressSummary: string;
  overallHealth: StandupOverallHealth;
  completedHighlights: Array<{
    userId?: string;
    displayName?: string;
    summary: string;
    workItemIds: number[];
    prIds?: number[];
  }>;
  blockers: Array<{
    summary: string;
    blockerType: 'pipeline' | 'person' | 'external' | 'incident' | 'other';
    ownerDisplayName?: string;
    workItemIds: number[];
  }>;
  atRiskItems: Array<{
    workItemId: number;
    title: string;
    assignee?: string;
    confidence: 'at_risk' | 'uncertain';
    reasons: string[];
    currentTargetDate?: string | null;
    suggestedTargetDate?: string | null;
  }>;
  carryoverAlerts: Array<{
    userId: string;
    displayName?: string;
    summary: string;
    workItemIds: number[];
  }>;
  handoffsAndReviews: Array<{
    summary: string;
    fromUser?: string;
    toUser?: string;
    workItemIds: number[];
    prIds?: number[];
  }>;
  capacityNotes: Array<{
    userId: string;
    displayName?: string;
    note: string;
  }>;
  decisionsNeeded: string[];
}

export interface StandupActionProposal {
  id: string;
  sessionId: string;
  participantId: string | null;
  project: string;
  workItemId: number;
  workItemTitle: string;
  proposalType: StandupProposalType;
  fieldName: string;
  currentValue: string | null;
  proposedValue: string;
  reason: string;
  confidence: StandupConfidence;
  status: 'pending' | 'applied' | 'dismissed';
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface StandupActionProposalInput {
  workItemId: number;
  workItemTitle: string;
  proposalType: StandupProposalType;
  fieldName: string;
  currentValue?: string | null;
  proposedValue: string;
  reason: string;
  confidence?: StandupConfidence;
}

export interface CalendarItemHealth {
  workItemId: number;
  confidence: StandupConfidence;
  reasons: string[];
  isBlockedOrStale: boolean;
  carryover: boolean;
}

export interface CalendarDeliveryPulseResponse {
  project: string;
  deliveryModel: StandupDeliveryModel;
  teamGoal: string | null;
  goalSource: StandupGoalSource;
  enableTargetDateChecks: boolean;
  staleDaysThreshold?: number;
  wipLimitPerPerson?: number | null;
  slaHoursHighPriority?: number | null;
  latestSessionId: string | null;
  latestSessionDate: string | null;
  overallHealth: StandupOverallHealth;
  counts: {
    onTrack: number;
    uncertain: number;
    atRisk: number;
    blockedOrStale: number;
    missingTargetDate: number;
    pendingProposals: number;
  };
  itemHealthById: Record<number, CalendarItemHealth>;
  proposals: StandupActionProposal[];
  teamPulse: StandupTeamPulse | null;
}

export interface MyStandupSessionResponse {
  participantId: string;
  sessionId: string;
  threadId: string | null;
  status: string;
  sessionDate: string;
  sessionStatus: string;
  config: {
    id: string;
    project: string;
    areaPath: string | null;
    deliveryModel: StandupDeliveryModel;
    goalSource: StandupGoalSource;
    teamGoal: string | null;
    policy: StandupDeliveryPolicy;
  };
  preparedBrief: ParticipantPreparedBrief | null;
  structuredUpdate: StandupStructuredUpdate | null;
  proposals: StandupActionProposal[];
}
