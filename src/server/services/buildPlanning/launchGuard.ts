/**
 * Live check before a planner launch. The flag and the initiator's builds:run
 * permission are read again here, not trusted from the start of the run.
 */
import { isFeatureEnabled } from '../featureFlagService';
import { getUserPermissions } from '../rbacService';

export type BuildLaunchRefusal = 'flag_disabled' | 'permission_revoked';

export class BuildLaunchRefusedError extends Error {
  readonly reason: BuildLaunchRefusal;

  constructor(reason: BuildLaunchRefusal) {
    super(reason === 'flag_disabled'
      ? 'Build from prompt is turned off.'
      : 'The person who started this build can no longer run builds.');
    this.name = 'BuildLaunchRefusedError';
    this.reason = reason;
  }
}

export interface LaunchGuardRun {
  userId: string;
  project: string;
}

export interface LaunchGuardDeps {
  loadRun?: (buildRunId: string) => Promise<LaunchGuardRun | null>;
  isFeatureEnabled?: typeof isFeatureEnabled;
  getUserPermissions?: typeof getUserPermissions;
}

export async function assertBuildLaunchAllowed(
  input: { buildRunId: string },
  deps: LaunchGuardDeps & { loadRun: (buildRunId: string) => Promise<LaunchGuardRun | null> },
): Promise<void> {
  const run = await deps.loadRun(input.buildRunId);
  if (!run) throw new BuildLaunchRefusedError('permission_revoked');

  const enabled = await (deps.isFeatureEnabled ?? isFeatureEnabled)('build-from-prompt', {
    userId: run.userId,
    project: run.project,
  });
  // @feature-flag:build-from-prompt start winner=enabled
  if (!enabled) {
    // @feature-flag:build-from-prompt disabled-start
    throw new BuildLaunchRefusedError('flag_disabled');
    // @feature-flag:build-from-prompt disabled-end
  }
  // @feature-flag:build-from-prompt enabled-start
  const permissions = await (deps.getUserPermissions ?? getUserPermissions)(run.userId, run.project);
  if (!permissions.has('builds:run')) throw new BuildLaunchRefusedError('permission_revoked');
  // @feature-flag:build-from-prompt enabled-end
  // @feature-flag:build-from-prompt end
}
