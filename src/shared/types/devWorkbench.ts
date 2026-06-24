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

export interface StartDevSessionRequest {
  workItemId: number;
  project: string;
  model?: string;
}

export type DevSessionStatus = 'setting_up' | 'in_progress' | 'failed' | 'closed';

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
  createdAt: string;
}

export interface DevDiff {
  diffText: string;
  changedFiles: string[];
  branch: string;
}

export interface ActiveDevSession {
  id: string;
  workItemId: number;
  chatThreadId: string | null;
  branchName: string | null;
  status: DevSessionStatus;
  createdAt: string;
}
