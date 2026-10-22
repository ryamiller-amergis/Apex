export const CODE_LAB_FLAG_KEY = 'code-lab';
export const CODE_LAB_PERMISSION = 'code-lab:use';

/** Mount path of the session-free preview proxy, relative to `/api`. */
export const CODE_LAB_PREVIEW_ROUTE = '/code-lab/preview/';

export type CodeLabPreviewKind = 'vite' | 'static' | 'unsupported';

export type CodeLabSessionStatus =
  | 'preparing'
  | 'starting_preview'
  | 'ready'
  | 'preview_unavailable'
  | 'failed'
  | 'stopped';

export interface CodeLabPreviewInfo {
  kind: CodeLabPreviewKind;
  /** Human-readable stack name, e.g. "React + Vite". */
  label: string;
  /** Folder inside the repository that the preview serves, '.' for the root. */
  appDir: string;
  /** Why the preview cannot run; set only when kind is 'unsupported'. */
  reason?: string;
}

export interface CodeLabSession {
  id: string;
  project: string;
  repo: string;
  baseBranch: string;
  branchName: string;
  status: CodeLabSessionStatus;
  statusDetail: string | null;
  preview: CodeLabPreviewInfo | null;
  /** Same-origin path of the running preview; null until the preview is ready. */
  previewUrl: string | null;
  chatThreadId: string | null;
  branchPushed: boolean;
  createdAt: string;
  lastActivityAt: string;
}

export interface StartCodeLabSessionRequest {
  project: string;
  model?: string;
}

export interface CodeLabDiff {
  diffText: string;
  changedFiles: string[];
  branch: string;
}

export interface CodeLabLogs {
  lines: string[];
}

export interface CodeLabPushResult {
  branch: string;
  changedFiles: string[];
}
