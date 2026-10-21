import { canAccessMyWork, type MyWorkAccessContext } from '../canAccessMyWork';

const base: MyWorkAccessContext = {
  can: () => false,
  isSuperAdmin: false,
  isInAnyGroup: () => false,
  enabledViews: [],
};

const inDeveloperGroup = (groups: string[]) => groups.includes('Developer');

describe('canAccessMyWork', () => {
  it('allows a Developer with the menu enabled and dev-workbench:view', () => {
    expect(canAccessMyWork({
      ...base,
      can: (k) => k === 'dev-workbench:view',
      enabledViews: ['my-work'],
      isInAnyGroup: inDeveloperGroup,
    })).toBe(true);
  });

  it('allows a Project Admin with admin:roles but no Developer group', () => {
    expect(canAccessMyWork({
      ...base,
      can: (k) => k === 'dev-workbench:view' || k === 'admin:roles',
      enabledViews: ['my-work'],
      isInAnyGroup: () => false,
    })).toBe(true);
  });

  it('allows a super admin regardless of menu, permission, or group', () => {
    expect(canAccessMyWork({ ...base, isSuperAdmin: true })).toBe(true);
  });

  it('denies when the my-work menu view is disabled', () => {
    expect(canAccessMyWork({
      ...base,
      can: (k) => k === 'dev-workbench:view' || k === 'admin:roles',
      enabledViews: [],
      isInAnyGroup: inDeveloperGroup,
    })).toBe(false);
  });

  it('denies when dev-workbench:view is missing', () => {
    expect(canAccessMyWork({
      ...base,
      can: (k) => k === 'admin:roles',
      enabledViews: ['my-work'],
      isInAnyGroup: inDeveloperGroup,
    })).toBe(false);
  });

  it('denies when the user is neither a Developer nor holds admin:roles', () => {
    expect(canAccessMyWork({
      ...base,
      can: (k) => k === 'dev-workbench:view',
      enabledViews: ['my-work'],
      isInAnyGroup: () => false,
    })).toBe(false);
  });

  it('treats a missing isInAnyGroup as no group membership', () => {
    expect(canAccessMyWork({
      can: (k) => k === 'dev-workbench:view',
      isSuperAdmin: false,
      enabledViews: ['my-work'],
    })).toBe(false);
  });
});
