export type DeploymentResult = 'success' | 'downtime' | 'rollback';

export interface DeploymentOutcome {
  id: string;
  deploymentId: string;
  releaseVersion: string;
  environment: string;
  result: DeploymentResult;
  downtimeMinutes?: number;
  details?: string;
  reportedBy: string;
  reportedAt: string;
  deployedAt?: string;
}

export interface CreateOutcomeInput {
  deploymentId: string;
  releaseVersion: string;
  result: DeploymentResult;
  downtimeMinutes?: number;
  details?: string;
  deployedAt?: string;
}

export interface UpdateOutcomeInput {
  result: DeploymentResult;
  downtimeMinutes?: number;
  details?: string;
  deployedAt?: string;
}

export interface OutcomeFilters {
  releaseVersion?: string;
  releaseVersions?: string[];
  startDate?: string;
  endDate?: string;
  result?: DeploymentResult;
}

export interface OutcomeSummary {
  total: number;
  success: number;
  downtime: number;
  rollback: number;
  avgDowntimeMinutes: number;
  byMonth: { month: string; success: number; downtime: number; rollback: number }[];
}
