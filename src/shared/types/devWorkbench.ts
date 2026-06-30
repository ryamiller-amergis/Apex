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

export type DevSessionStatus = 'setting_up' | 'in_progress' | 'conflict' | 'failed' | 'closed';

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
  createdAt: string;
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
  prUrl?: string;
  conflictedFiles?: ConflictedFile[];
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
  prUrl: string | null;
  createdAt: string;
}
