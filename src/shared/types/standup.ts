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

export type StandupRosterMode = 'ado_and_groups' | 'ado_active' | 'groups_only';

export const STANDUP_ROSTER_MODES: readonly StandupRosterMode[] = [
  'ado_and_groups',
  'ado_active',
  'groups_only',
] as const;

export const STANDUP_ROSTER_MODE_LABELS: Record<StandupRosterMode, string> = {
  ado_and_groups: 'ADO Work Items + Groups (Auto-discover)',
  ado_active: 'Active ADO Assignees Only',
  groups_only: 'Selected Groups Only',
};

export const STANDUP_ROSTER_MODE_SHORT_LABELS: Record<StandupRosterMode, string> = {
  ado_and_groups: 'ADO + Groups',
  ado_active: 'ADO Active Only',
  groups_only: 'Groups Only',
};

export type StandupWorkDomain =
  | 'database'
  | 'iac'
  | 'backend'
  | 'frontend'
  | 'qa'
  | 'security'
  | 'prod_support'
  | 'general';

export const STANDUP_WORK_DOMAINS: readonly StandupWorkDomain[] = [
  'database',
  'iac',
  'prod_support',
  'security',
  'backend',
  'frontend',
  'qa',
  'general',
] as const;

export const STANDUP_WORK_DOMAIN_LABELS: Record<StandupWorkDomain, string> = {
  database: 'Database / SQL',
  iac: 'Infra / Terraform',
  backend: 'Backend / API',
  frontend: 'Frontend / UI',
  qa: 'QA & Testing',
  security: 'Security & Auth',
  prod_support: 'Prod Support',
  general: 'General',
};

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

export type StandupItemDecision = 'approved' | 'rejected';

export type StandupApprovalAction =
  | 'approved'
  | 'approved_with_edits'
  | 'rejected_rewritten';

export interface StandupRejectedItemRecord {
  id: string;
  summary: string;
  reason?: string;
}

export interface StandupStructuredUpdate {
  yesterday?: string;
  today?: string;
  blockers?: string;
  atRisk?: string;
  handoffs?: string;
  capacity?: string;
  itemDecisions?: Record<string, StandupItemDecision>;
  rejectedItems?: StandupRejectedItemRecord[];
  userCorrections?: string;
  approvalAction?: StandupApprovalAction;
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

export type StandupActivityAttribution = 'confirmed' | 'suggested';

export interface StandupSuggestedActivity {
  id: string;
  bucket: 'yesterday' | 'today';
  summary: string;
  source: 'ado' | 'github' | 'history' | 'followup';
  actor?: string;
  owner?: string;
  workItemId?: number;
  prId?: number;
  attribution: StandupActivityAttribution;
  reason: string;
}

export interface StandupCheckInValues {
  yesterday: string;
  today: string;
  blockers?: string;
  handoffs?: string;
  capacity?: string;
  userCorrections?: string;
}

export const STANDUP_CHECK_IN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'StandupCheckIn',
  type: 'object',
  additionalProperties: false,
  required: ['today'],
  properties: {
    yesterday: {
      type: 'string',
      title: 'Since last standup',
      maxLength: 2000,
    },
    today: {
      type: 'string',
      title: "Today's focus",
      minLength: 1,
      maxLength: 2000,
    },
    blockers: {
      type: 'string',
      title: 'Blockers or help needed',
      maxLength: 1000,
    },
    handoffs: {
      type: 'string',
      title: 'Handoffs or reviews needed',
      maxLength: 1000,
    },
    capacity: {
      type: 'string',
      title: 'Availability note',
      maxLength: 500,
    },
    userCorrections: {
      type: 'string',
      title: 'Additional note or correction',
      maxLength: 1000,
    },
  },
} as const;

export interface StandupDraftedItem {
  id: string;
  bucket: 'yesterday' | 'today' | 'blocker';
  summary: string;
  workItemId?: number;
  prId?: number;
  domain?: StandupWorkDomain;
  evidence: string;
  attribution?: StandupActivityAttribution;
  owner?: string;
}

export interface ParticipantCarryoverStreak {
  workItemId: number;
  title: string;
  daysCarried: number;
}

export interface ParticipantMultiDayArc {
  sessionsAnalyzed: number;
  summary: string;
  carryoverStreaks: ParticipantCarryoverStreak[];
}

export type StandupSdlcCalloutCategory =
  | 'sql_migration'
  | 'iac_pipeline'
  | 'release_readiness'
  | 'missing_tests'
  | 'red_build_in_qa'
  | 'pr_state_drift';

export interface StandupSdlcCallout {
  id: string;
  category: StandupSdlcCalloutCategory;
  severity: 'critical' | 'warning' | 'info';
  domain: StandupWorkDomain;
  title: string;
  detail: string;
  recommendation: string;
  ownerDisplayName?: string;
  workItemIds: number[];
  prIds?: number[];
  filePaths?: string[];
}

export interface StandupAreaBreakdownEntry {
  domain: StandupWorkDomain;
  label: string;
  activeItemCount: number;
  contributors: string[];
  keyFocus: string;
  riskCount: number;
}

export interface ParticipantStandupNarrative {
  userId: string;
  displayName: string;
  status: 'confirmed' | 'ai_drafted';
  domains: StandupWorkDomain[];
  arcSummary: string;
  yesterdaySummary: string;
  todayFocus: string;
  blockersSummary: string;
  handoffsSummary?: string;
  capacitySummary?: string;
  userCorrections?: string;
  carryoverCount: number;
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
  draftedItems?: StandupDraftedItem[];
  suggestedActivity?: StandupSuggestedActivity[];
  proposedQuestions?: string[];
  hasExternalEvidence?: boolean;
  recommendedFocus?: string;
  multiDayArc?: ParticipantMultiDayArc;
  workDomains?: StandupWorkDomain[];
  sdlcCallouts?: StandupSdlcCallout[];
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
  facilitatorPrompts?: string[];
  sdlcCallouts?: StandupSdlcCallout[];
  areaBreakdown?: StandupAreaBreakdownEntry[];
  individualNarratives?: ParticipantStandupNarrative[];
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

export interface StandupRosterMember {
  userId: string;
  displayName: string | null;
  email: string | null;
  source: 'ado' | 'group' | 'both';
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
    rosterMode?: StandupRosterMode;
    policy: StandupDeliveryPolicy;
  };
  preparedBrief: ParticipantPreparedBrief | null;
  structuredUpdate: StandupStructuredUpdate | null;
  proposals: StandupActionProposal[];
}
