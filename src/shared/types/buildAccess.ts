/** Permission keys for Build from Prompt (FEAT-002 / TBI-004). */
export const BUILDS_VIEW = 'builds:view';
export const BUILDS_RUN = 'builds:run';

/** Returned when `build-from-prompt` is off for the caller's user and project. */
export const BUILD_FLAG_DISABLED_CODE = 'BUILD_FLAG_DISABLED';
export const BUILD_FLAG_DISABLED_MESSAGE =
  'Builds are turned off for this project right now. Ask a Platform Admin if you need them.';

/** Shown when a build-intake chat message is refused because `build-from-prompt` is off. Reads stay open. */
export const BUILD_INTAKE_PAUSED_MESSAGE =
  'Builds are paused for this project. Your conversation is saved. Ask a Project Admin to resume builds.';

export const BUILD_INTAKE_ATTACHMENTS_MESSAGE = 'Attachments are not supported in a build intake chat.';

/** Returned when the project and repository pair is not on the build allow-list. */
export const BUILD_PAIR_NOT_ALLOWED_CODE = 'BUILD_PAIR_NOT_ALLOWED';
export const BUILD_PAIR_NOT_ALLOWED_MESSAGE =
  'This repository is not approved for builds in this project. Ask a Platform Admin to approve it.';

export type BuildAccessRefusalCode =
  | typeof BUILD_FLAG_DISABLED_CODE
  | typeof BUILD_PAIR_NOT_ALLOWED_CODE;

export interface BuildAccessRefusal {
  error: string;
  code: BuildAccessRefusalCode;
}

export type BuildAllowlistAuditAction = 'added' | 'removed';

export interface BuildAllowlistEntry {
  id: string;
  project: string;
  /** Canonical repository name copied from the project's skill settings row. */
  repository: string;
  createdBy: string | null;
  createdAt: string;
}

export interface BuildAllowlistResponse {
  entries: BuildAllowlistEntry[];
}

export interface BuildAllowlistRepositoriesResponse {
  repositories: string[];
}

export interface AddBuildAllowlistEntryRequest {
  project: string;
  repository: string;
}
