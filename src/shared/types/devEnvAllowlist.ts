import type { AppEnvironment } from './appEnvironment';

/** Returned when a signed-in user is not allowed to use the dev site. */
export const DEV_ENV_ACCESS_DENIED_CODE = 'DEV_ENV_ACCESS_DENIED';

export const DEV_ENV_ACCESS_DENIED_MESSAGE =
  'The dev site is limited to people a platform admin has approved.';

export interface DevEnvAllowlistEntry {
  id: string;
  email: string;
  createdBy: string | null;
  createdAt: string;
}

export interface DevEnvAllowlistResponse {
  environment: AppEnvironment;
  /** True only on the dev site, where this list controls who can sign in. */
  managesDevAccess: boolean;
  entries: DevEnvAllowlistEntry[];
}
