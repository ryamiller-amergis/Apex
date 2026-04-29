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
  devTimeDays: number | null;
  bugCount: number;
  prModificationRounds: number;
  fullCycleTimeDays: number | null;
  hasRework: boolean;
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
  avgPRModifications: number;
  avgFullCycleTimeDays: number;
  reworkRate: number;
  firstPassRate: number;
  itemsWithZeroBugs: number;
  itemsWithCleanPRMerge: number;
  items: AIWorkItemMetric[];
}

export * from '../../shared/types/backlog';
