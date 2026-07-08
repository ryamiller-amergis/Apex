export interface AssignedWorkItem {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  assignedTo: string;
  project: string;
  areaPath?: string;
  iterationPath?: string;
  url?: string;
}

export interface BacklogFeatureItem {
  featureId: string;
  featureTitle: string;
  featurePriority: string;
  epicTitle: string;
  prdId: string;
  prdTitle: string;
  dependsOn: string[];
  designDocId?: string;
  designDocStatus?: string;
  itemCount: number;
  pbiCount: number;
  tbiCount: number;
}

export interface ApexBacklogGroup {
  prdId: string;
  prdTitle: string;
  epics: {
    epicTitle: string;
    features: BacklogFeatureItem[];
  }[];
}

export interface StartDevSessionRequest {
  workItemId?: number;
  project: string;
  model?: string;
  prdId?: string;
  featureId?: string;
}

export type DevSessionStatus = 'setting_up' | 'in_progress' | 'conflict' | 'failed' | 'closed' | 'completed';

export interface StartDevSessionResponse {
  sessionId: string;
}

export interface DevSessionDetail {
  id: string;
  workItemId: number;
  chatThreadId: string | null;
  branchName: string | null;
  status: DevSessionStatus;
  setupError: string | null;
  prUrl: string | null;
  branchPushed: boolean;
  createdAt: string;
  prdId?: string | null;
  featureId?: string | null;
}

export interface ConflictedFile {
  path: string;
  content: string;
}

export interface PushSessionResponse {
  ok: boolean;
  /** Set when the merge produced conflicts — push and PR are blocked until resolved. */
  status: 'clean' | 'conflict';
  branch?: string;
  branchPushed?: boolean;
  conflictedFiles?: ConflictedFile[];
}

export interface CreatePrResponse {
  prUrl: string | null;
}

export interface DevDiff {
  diffText: string;
  changedFiles: string[];
  branch: string;
  branchPushed?: boolean;
}

export interface ActiveDevSession {
  id: string;
  workItemId: number;
  chatThreadId: string | null;
  branchName: string | null;
  status: DevSessionStatus;
  prUrl: string | null;
  createdAt: string;
  prdId?: string | null;
  featureId?: string | null;
}
