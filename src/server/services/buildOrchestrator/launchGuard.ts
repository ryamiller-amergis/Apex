/**
 * Live check before every task launch. The flag and the requester's builds:run
 * permission are read again each time, never trusted from the start of the run.
 */
import { isFeatureEnabled, isFeatureOperational } from '../featureFlagService';
import { getUserPermissions } from '../rbacService';
import { isSuperAdminEmail } from '../../utils/superAdmin';

export const BUILD_FROM_PROMPT_FLAG = 'build-from-prompt';

export interface GuardRun {
  requesterUserId: string;
  project: string;
}

export type BuildFlagState = 'on' | 'off';

export type LaunchGuardDecision =
  | { outcome: 'allow' }
  | { outcome: 'refuse'; reason: 'flag_disabled' | 'permission_revoked' }
  /** A lookup threw. Leave the task ready and try again on the next pass. */
  | { outcome: 'defer'; detail: string };

export interface LaunchGuardDeps {
  isFeatureOperational(key: string): Promise<boolean>;
  isFeatureEnabled(key: string, ctx: { userId: string; project: string }): Promise<boolean>;
  getUserPermissions(userId: string, project: string): Promise<Set<string>>;
  loadUserEmail(userId: string): Promise<string | null>;
  isSuperAdminEmail(email: string): boolean;
}

export function defaultLaunchGuardDeps(loadUserEmail: LaunchGuardDeps['loadUserEmail']): LaunchGuardDeps {
  return {
    isFeatureOperational,
    isFeatureEnabled,
    getUserPermissions,
    loadUserEmail,
    isSuperAdminEmail: (email) => isSuperAdminEmail(email),
  };
}

/** Off when the global switch is off or the project rules no longer cover the requester. Throws on lookup errors. */
export async function readBuildFlag(run: GuardRun, deps: LaunchGuardDeps): Promise<BuildFlagState> {
  if (!(await deps.isFeatureOperational(BUILD_FROM_PROMPT_FLAG))) return 'off';
  const enabled = await deps.isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, {
    userId: run.requesterUserId,
    project: run.project,
  });
  return enabled ? 'on' : 'off';
}

export async function checkTaskLaunch(run: GuardRun, deps: LaunchGuardDeps): Promise<LaunchGuardDecision> {
  try {
    const flag = await readBuildFlag(run, deps);
    // @feature-flag:build-from-prompt start winner=enabled
    if (flag === 'off') {
      // @feature-flag:build-from-prompt disabled-start
      return { outcome: 'refuse', reason: 'flag_disabled' };
      // @feature-flag:build-from-prompt disabled-end
    }
    // @feature-flag:build-from-prompt enabled-start
    const email = await deps.loadUserEmail(run.requesterUserId);
    if (email && deps.isSuperAdminEmail(email)) return { outcome: 'allow' };
    const permissions = await deps.getUserPermissions(run.requesterUserId, run.project);
    return permissions.has('builds:run')
      ? { outcome: 'allow' }
      : { outcome: 'refuse', reason: 'permission_revoked' };
    // @feature-flag:build-from-prompt enabled-end
    // @feature-flag:build-from-prompt end
  } catch (error) {
    return { outcome: 'defer', detail: error instanceof Error ? error.message : String(error) };
  }
}
