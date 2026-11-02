import type { BuildTaskRole } from './build';

/** Repository-relative file and its SHA-256 hex digest. */
export interface FilePointer {
  path: string;
  contentHash: string;
}

/** Blob location and the SHA-256 hex digest of its text. */
export interface BlobPointer {
  container: string;
  key: string;
  contentHash: string;
}

export interface BuildLaunchContextPointer extends BlobPointer {
  label: string;
}

export interface BuildLaunchCaps {
  costUsd: number;
  elapsedMs: number;
  revisions: number;
  /** 1 to 6. */
  parallelism: number;
}

/**
 * Fully resolved launch input for one build task attempt. Written once to
 * `agent_runs.build_launch_snapshot` before the SDK call; the launch reads
 * nothing else. Holds pointers and `app-setting:<NAME>` references only.
 */
export interface BuildLaunchSnapshot {
  schemaVersion: 1;
  buildRunId: string;
  buildRevisionId: string;
  buildTaskId: string;
  taskKey: string;
  role: BuildTaskRole;
  /** Integer >= 1. A retry is a new row with a higher attempt. */
  attempt: number;
  model: string;
  skill: FilePointer;
  standards: {
    designSystem: FilePointer;
    codingRules: FilePointer;
    codeMap: FilePointer;
  };
  /** The full assembled prompt. */
  prompt: BlobPointer;
  /** Where the prompt came from. Not fetched at launch. At least one entry. */
  context: BuildLaunchContextPointer[];
  repository: {
    provider: 'ado' | 'github';
    project: string;
    repo: string;
    defaultBranch: string;
  };
  startingBranch: string;
  /** Never equal to `repository.defaultBranch`. */
  targetBranch: string;
  pullRequest: { open: false };
  caps: BuildLaunchCaps;
  /** `app-setting:NAME` entries only. May be empty, never absent. */
  secretRefs: string[];
}

export type BuildLaunchRefusalCode =
  | 'snapshot_missing'
  | 'snapshot_field_missing'
  | 'snapshot_field_invalid'
  | 'snapshot_unknown_field'
  | 'snapshot_secret_value'
  | 'project_mismatch'
  | 'target_is_default_branch'
  | 'pull_request_not_allowed'
  | 'prompt_hash_mismatch'
  | 'prompt_contains_held_secret';

/** Carries a code and a field path. Never the offending value. */
export interface BuildLaunchRefusal {
  code: BuildLaunchRefusalCode;
  fieldPath?: string;
}
