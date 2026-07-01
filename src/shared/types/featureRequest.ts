export type FeatureRequestStatus = 'new' | 'under-review' | 'planned' | 'declined' | 'done';
export type FeatureRequestAiStatus = 'pending' | 'analyzing' | 'complete' | 'failed';
export type FeatureRequestPriority = 'low' | 'medium' | 'high' | 'critical';
export type FeatureRequestRisk = 'low' | 'medium' | 'high';

export const FEATURE_REQUEST_STATUSES: FeatureRequestStatus[] = [
  'new', 'under-review', 'planned', 'declined', 'done',
];

export const FEATURE_REQUEST_AI_STATUSES: FeatureRequestAiStatus[] = [
  'pending', 'analyzing', 'complete', 'failed',
];

export const FEATURE_REQUEST_PRIORITIES: FeatureRequestPriority[] = [
  'low', 'medium', 'high', 'critical',
];

export const FEATURE_REQUEST_RISKS: FeatureRequestRisk[] = [
  'low', 'medium', 'high',
];

export interface FeatureRequest {
  id: string;
  title: string;
  request: string;
  advantage: string;
  submittedBy: string;
  sourceProject: string;
  status: FeatureRequestStatus;
  aiStatus: FeatureRequestAiStatus;
  aiPriority: FeatureRequestPriority | null;
  aiRisk: FeatureRequestRisk | null;
  aiRationale: string | null;
  aiThreadId: string | null;
  teamPriority: FeatureRequestPriority | null;
  teamRisk: FeatureRequestRisk | null;
  rank: number | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** Joined from app_users for display */
  submitterName?: string;
}

export interface CreateFeatureRequestDTO {
  title: string;
  request: string;
  advantage: string;
  project: string;
}

export interface UpdateFeatureRequestDTO {
  status?: FeatureRequestStatus;
  teamPriority?: FeatureRequestPriority | null;
  teamRisk?: FeatureRequestRisk | null;
  rank?: number | null;
}
