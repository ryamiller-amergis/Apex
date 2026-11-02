jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn(),
  isFeatureOperational: jest.fn(),
}));
jest.mock('../services/rbacService', () => ({ getUserPermissions: jest.fn() }));

import {
  BUILD_FROM_PROMPT_FLAG,
  checkTaskLaunch,
  readBuildFlag,
  type LaunchGuardDeps,
} from '../services/buildOrchestrator/launchGuard';

const RUN = { requesterUserId: 'user-1', project: 'Apex' };

function deps(overrides: Partial<LaunchGuardDeps> = {}): LaunchGuardDeps {
  return {
    isFeatureOperational: jest.fn(async () => true),
    isFeatureEnabled: jest.fn(async () => true),
    getUserPermissions: jest.fn(async () => new Set(['builds:run'])),
    loadUserEmail: jest.fn(async () => 'member@example.com'),
    isSuperAdminEmail: jest.fn(() => false),
    ...overrides,
  };
}

describe('checkTaskLaunch (TBI-018 DoD-2, PBI-020 AC-3, PBI-021 AC-0)', () => {
  it('allows a member who still holds builds:run while the flag is on', async () => {
    const guard = deps();
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'allow' });
    expect(guard.isFeatureEnabled).toHaveBeenCalledWith(BUILD_FROM_PROMPT_FLAG, { userId: 'user-1', project: 'Apex' });
    expect(guard.getUserPermissions).toHaveBeenCalledWith('user-1', 'Apex');
  });

  it('VT-06: refuses with flag_disabled when the global switch is off', async () => {
    const guard = deps({ isFeatureOperational: jest.fn(async () => false) });
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'refuse', reason: 'flag_disabled' });
    expect(guard.getUserPermissions).not.toHaveBeenCalled();
  });

  it('VT-07: refuses with flag_disabled when the project rule no longer covers the requester', async () => {
    const guard = deps({ isFeatureEnabled: jest.fn(async () => false) });
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'refuse', reason: 'flag_disabled' });
  });

  it('VT-08 PBI-020 AC-3: refuses with permission_revoked when builds:run is gone', async () => {
    const guard = deps({ getUserPermissions: jest.fn(async () => new Set(['builds:view'])) });
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'refuse', reason: 'permission_revoked' });
  });

  it('VT-08: a super admin requester is allowed without the permission lookup', async () => {
    const guard = deps({
      isSuperAdminEmail: jest.fn(() => true),
      getUserPermissions: jest.fn(async () => new Set<string>()),
    });
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'allow' });
    expect(guard.getUserPermissions).not.toHaveBeenCalled();
  });

  it('VT-08: a super admin does not bypass a flag that is off', async () => {
    const guard = deps({ isFeatureOperational: jest.fn(async () => false), isSuperAdminEmail: jest.fn(() => true) });
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'refuse', reason: 'flag_disabled' });
  });

  it('VT-09: a flag lookup error defers instead of refusing', async () => {
    const guard = deps({ isFeatureOperational: jest.fn(async () => { throw new Error('db down'); }) });
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'defer', detail: 'db down' });
  });

  it('VT-09: a permission lookup error defers instead of refusing', async () => {
    const guard = deps({ getUserPermissions: jest.fn(async () => { throw new Error('rbac down'); }) });
    await expect(checkTaskLaunch(RUN, guard)).resolves.toEqual({ outcome: 'defer', detail: 'rbac down' });
  });
});

describe('readBuildFlag (PBI-021 AC-0)', () => {
  it('is off when either check is off and on only when both are on', async () => {
    await expect(readBuildFlag(RUN, deps())).resolves.toBe('on');
    await expect(readBuildFlag(RUN, deps({ isFeatureOperational: jest.fn(async () => false) }))).resolves.toBe('off');
    await expect(readBuildFlag(RUN, deps({ isFeatureEnabled: jest.fn(async () => false) }))).resolves.toBe('off');
  });
});
