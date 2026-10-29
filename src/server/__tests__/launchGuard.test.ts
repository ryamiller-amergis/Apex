/**
 * PBI-014 — launch guard. VT-16.
 */
import { assertBuildLaunchAllowed, BuildLaunchRefusedError } from '../services/buildPlanning/launchGuard';

describe('planner launch guard', () => {
  const loadRun = async () => ({ userId: 'user-1', project: 'apex' });

  it('VT-16 throws when the flag is off', async () => {
    await expect(assertBuildLaunchAllowed({ buildRunId: 'run-1' }, {
      loadRun,
      isFeatureEnabled: async () => false,
      getUserPermissions: async () => new Set(['builds:run']),
    })).rejects.toMatchObject({ reason: 'flag_disabled' });
  });

  it('VT-16 throws when builds:run was revoked', async () => {
    await expect(assertBuildLaunchAllowed({ buildRunId: 'run-1' }, {
      loadRun,
      isFeatureEnabled: async () => true,
      getUserPermissions: async () => new Set(['builds:view']),
    })).rejects.toBeInstanceOf(BuildLaunchRefusedError);
    await expect(assertBuildLaunchAllowed({ buildRunId: 'run-1' }, {
      loadRun,
      isFeatureEnabled: async () => true,
      getUserPermissions: async () => new Set(['builds:view']),
    })).rejects.toMatchObject({ reason: 'permission_revoked' });
  });

  it('VT-16 returns when the flag is on and builds:run is still held', async () => {
    await expect(assertBuildLaunchAllowed({ buildRunId: 'run-1' }, {
      loadRun,
      isFeatureEnabled: async () => true,
      getUserPermissions: async () => new Set(['builds:run']),
    })).resolves.toBeUndefined();
  });
});
