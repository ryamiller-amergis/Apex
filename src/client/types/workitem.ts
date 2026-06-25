export interface WorkItem {
  id: number;
  title: string;
  state: string;
  assignedTo?: string;
  dueDate?: string;
  targetDate?: string;
  qaCompleteDate?: string;
  workItemType: string;
  changedDate: string;
  createdDate: string;
  closedDate?: string;
  areaPath: string;
  iterationPath: string;
  tags?: string;
  cycleTime?: CycleTimeData;
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
  design?: string;
  discussions?: string;
  parentId?: number;
}

export interface StateTransition {
  fromState: string;
  toState: string;
  changedDate: string;
  changedBy?: string;
}

export interface CycleTimeData {
  inProgressDate?: string;
  qaReadyDate?: string;
  cycleTimeDays?: number;
}

export interface DueDateChange {
  changedDate: string;
  changedBy: string;
  oldDueDate?: string;
  newDueDate?: string;
  reason?: string;
}

export interface DeveloperDueDateStats {
  developer: string;
  totalChanges: number;
  reasonBreakdown: { [reason: string]: number };
}

export interface DueDateHitRateStats {
  developer: string;
  totalWorkItems: number;
  hitDueDate: number;
  missedDueDate: number;
  hitRate: number;
  workItemDetails: Array<{
    id: number;
    title: string;
    workItemType: string;
    dueDate: string;
    completionDate: string;
    dueDateChangeReasons: string[];
    hit: boolean;
    status: 'hit' | 'miss' | 'in-progress';
  }>;
}

export interface PullRequestTimeStats {
  developer: string;
  totalItemsInPullRequest: number;
  totalActivePullRequests: number;
  totalCompletedPullRequests: number;
  averageTimeInPullRequest: number;
  totalTimeInPullRequest: number;
  workItemDetails: Array<{
    id: number;
    title: string;
    timeInPullRequestDays: number;
    enteredPullRequestDate: string;
    exitedPullRequestDate: string;
    prUrl?: string;
    repositoryName?: string;
    isActive?: boolean;
  }>;
}

export interface QABugStats {
  developer: string;
  totalPBIs: number;
  totalBugs: number;
  averageBugsPerPBI: number;
  pbiDetails: Array<{
    id: number;
    title: string;
    bugCount: number;
    bugs: Array<{
      id: number;
      title: string;
      state: string;
    }>;
  }>;
}

export interface DesignDocKickoffStats {
  developer: string;
  totalWorkItems: number;
  kickoffCount: number;
  adoptionRate: number;
  kickoffDetails: Array<{
    workItemId: number;
    title: string;
    workItemType: 'Product Backlog Item' | 'Technical Backlog Item' | 'Bug';
    filePath: string;
    commitDate: string;
    prId?: number;
    prUrl?: string;
  }>;
}

export interface InProgressTimeStats {
  developer: string;
  totalItemsInProgress: number;
  averageDaysInProgress: number;
  totalDaysInProgress: number;
  workItemDetails: Array<{
    id: number;
    title: string;
    workItemType: string;
    daysInProgress: number;
    enteredInProgressDate: string;
    exitedInProgressDate: string | null;
    isCurrentlyInProgress: boolean;
  }>;
}

export interface PullRequestFeedbackStats {
  developer: string;
  totalPRsReviewed: number;
  totalCommentsGiven: number;
  totalApprovalsGiven: number;
  totalRejectionsGiven: number;
  prDetails: Array<{
    prId: number;
    title: string;
    prUrl: string;
    creator: string;
    repositoryName: string;
    commentsGiven: number;
    vote: number; // -10 rejected, -5 waiting, 0 none, 5 approved with suggestions, 10 approved
    createdDate: string;
  }>;
}

/** Single row from agent-evals `pr-resolution-metrics.json` files */
export interface PrResolutionMetricFileRow {
  prId: number;
  date: string;
  timestamp?: string;
  total: number;
  accepted: number;
  wontfix: number;
  snoozed: number;
  acceptanceRate?: number;
  byCategory?: Record<string, { total?: number; accepted?: number; wontfix?: number; snoozed?: number }>;
}

export interface PrResolutionMetricsCategoryBucket {
  total: number;
  accepted: number;
  wontfix: number;
  snoozed: number;
}

/** Aggregated PR comment resolution metrics per PR author (from eval JSON + ADO PR metadata) */
export interface PrResolutionMetricsStats {
  developer: string;
  prCount: number;
  snapshotCount: number;
  totalComments: number;
  accepted: number;
  wontfix: number;
  snoozed: number;
  acceptanceRate: number;
  byCategory: Record<string, PrResolutionMetricsCategoryBucket>;
  prDetails: Array<{
    prId: number;
    date: string;
    prTitle: string;
    prUrl: string;
    repositoryName: string;
    total: number;
    accepted: number;
    wontfix: number;
    snoozed: number;
    acceptanceRate: number;
  }>;
}

export interface EslintMetricsSnapshot {
  repoName: string;
  capturedAt: string;
  totalFiles: number;
  filesWithIssues: number;
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
  issueCount: number;
  topRules: Array<{
    ruleId: string;
    count: number;
    errorCount: number;
    warningCount: number;
  }>;
  topFiles: Array<{
    filePath: string;
    errorCount: number;
    warningCount: number;
    issueCount: number;
  }>;
  stderr?: string;
}

/** JSON shape published by the MaxView nightly ESLint pipeline artifact. */
export interface EslintSummaryArtifact {
  schemaVersion: number;
  generatedAt: string;
  build: {
    id: string;
    buildNumber: string;
    definitionName: string;
    sourceBranch: string;
    sourceVersion: string;
  };
  eslint: {
    totalFiles: number;
    filesWithProblems: number;
    totalErrors: number;
    totalWarnings: number;
    totalFixableErrors: number;
    totalFixableWarnings: number;
  };
}

export interface EslintBuildSnapshot {
  capturedAt: string;
  buildId: string;
  buildNumber: string;
  definitionName: string;
  totalFiles: number;
  filesWithProblems: number;
  totalErrors: number;
  totalWarnings: number;
  issueCount: number;
  fixableCount: number;
}

export type EslintBurnDownGranularity = 'weekly' | 'monthly' | 'quarterly';

export interface EslintBurnDownPoint {
  periodKey: string;
  periodLabel: string;
  capturedAt: string;
  buildId: string;
  buildNumber: string;
  totalErrors: number;
  totalWarnings: number;
  issueCount: number;
  filesWithProblems: number;
  fixableCount: number;
}

export interface EslintBurnDownResponse {
  from: string;
  to: string;
  definitionName: string;
  artifactName: string;
  snapshots: EslintBuildSnapshot[];
  latest: EslintBuildSnapshot | null;
  summary: {
    definitionId?: number;
    buildsScanned: number;
    buildsWithArtifact: number;
    startingIssueCount: number | null;
    endingIssueCount: number | null;
    issueReduction: number | null;
    reductionPercent: number | null;
    hint?: string;
  };
}

export interface QACycleTimeStats {
  qaAssignee: string;
  totalItems: number;
  averageCycleTimeDays: number;
  totalCycleTimeDays: number;
  workItemDetails: Array<{
    id: number;
    title: string;
    workItemType: string;
    cycleTimeDays: number;
    enteredInTestDate: string;
    exitedInTestDate: string;
    exitState: string;
  }>;
}

export interface UATCycleTimeStats {
  assignee: string;
  totalItems: number;
  averageCycleTimeDays: number;
  totalCycleTimeDays: number;
  workItemDetails: Array<{
    id: number;
    title: string;
    workItemType: string;
    cycleTimeDays: number;
    enteredUATReadyDate: string;
    exitedUATReadyDate: string;
  }>;
}

export interface UATSittingItem {
  id: number;
  title: string;
  workItemType: string;
  assignedTo: string;
  enteredUATReadyDate: string;
  daysSitting: number;
}

export type DeploymentEnvironment = 'dev' | 'staging' | 'production';

export interface Deployment {
  id: string;
  releaseVersion: string;
  environment: DeploymentEnvironment;
  workItemIds: number[];
  deployedBy: string;
  deployedAt: string;
  notes?: string;
}

export interface Release {
  version: string;
  name: string;
  targetDate?: string;
  features: WorkItem[];
  status: 'planning' | 'in-progress' | 'ready' | 'deployed' | 'completed';
  completionPercentage: number;
  health: 'on-track' | 'at-risk' | 'blocked';
  deployments: Deployment[];
}

export interface ReleaseMetrics {
  releaseVersion: string;
  totalFeatures: number;
  completedFeatures: number;
  inProgressFeatures: number;
  blockedFeatures: number;
  readyForReleaseFeatures: number;
  uatReadyForTestFeatures: number;
  averageLeadTime?: number;
  deploymentHistory: Deployment[];
}

export interface AIWorkItemMetric {
  id: number;
  title: string;
  workItemType: string;
  assignedTo: string;
  state: string;
  devTimeDays: number | null;
  bugCount: number;
  fullCycleTimeDays: number | null;
  hasRework: boolean;
  isFirstPassEvaluated: boolean;
  isFirstPassSuccess: boolean;
  inProgressDate: string | null;
  inPullRequestDate: string | null;
  uatReadyDate: string | null;
  bugs: Array<{ id: number; title: string; state: string }>;
}

export interface AIWorkItemHealthSummary {
  totalItems: number;
  aggregateScore: number;
  avgDevTimeDays: number;
  medianDevTimeDays: number;
  avgBugCount: number;
  avgFullCycleTimeDays: number;
  reworkRate: number;
  firstPassRate: number;
  itemsWithZeroBugs: number;
  items: AIWorkItemMetric[];
}

export * from '../../shared/types/backlog';
