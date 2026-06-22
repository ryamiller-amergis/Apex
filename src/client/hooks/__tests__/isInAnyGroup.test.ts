/**
 * Unit tests for the isInAnyGroup logic extracted from useAppShell.
 *
 * The hook computes isInAnyGroup as:
 *   (names: string[]) => isSuperAdmin || isAdmin || groups.some(g => names.includes(g))
 *
 * where isAdmin = isSuperAdmin || roles.includes('admin')
 *
 * These tests verify the pure logic independently of React rendering.
 */

function makeIsInAnyGroup(opts: {
  isSuperAdmin: boolean;
  roles: string[];
  groups: string[];
}) {
  const { isSuperAdmin, roles, groups } = opts;
  const isAdmin = isSuperAdmin || roles.includes('admin');
  return (names: string[]) => isSuperAdmin || isAdmin || groups.some(g => names.includes(g));
}

describe('isInAnyGroup logic', () => {
  it('returns true for a super admin regardless of groups', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: true, roles: [], groups: [] });
    expect(isInAnyGroup(['BA', 'Manager'])).toBe(true);
    expect(isInAnyGroup([])).toBe(true);
  });

  it('returns true for an admin (roles includes "admin") regardless of groups', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: false, roles: ['admin'], groups: [] });
    expect(isInAnyGroup(['BA', 'Manager', 'Product-Owner'])).toBe(true);
    expect(isInAnyGroup([])).toBe(true);
  });

  it('returns true when the user is in a matching group', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: false, roles: ['member'], groups: ['BA'] });
    expect(isInAnyGroup(['BA', 'Manager', 'Product-Owner'])).toBe(true);
  });

  it('returns true when the user is in a second matching group (not the first)', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: false, roles: ['member'], groups: ['Product-Owner'] });
    expect(isInAnyGroup(['BA', 'Manager', 'Product-Owner'])).toBe(true);
  });

  it('returns false when the user is not in any of the requested groups', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: false, roles: ['member'], groups: ['Developer', 'QA'] });
    expect(isInAnyGroup(['BA', 'Manager', 'Product-Owner'])).toBe(false);
  });

  it('returns false when the user has an empty groups array', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: false, roles: ['member'], groups: [] });
    expect(isInAnyGroup(['BA', 'Manager', 'Product-Owner'])).toBe(false);
  });

  it('returns false when the names array to check against is empty', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: false, roles: ['member'], groups: ['BA'] });
    expect(isInAnyGroup([])).toBe(false);
  });

  it('returns false for a regular user with no matching groups and no admin role', () => {
    const isInAnyGroup = makeIsInAnyGroup({ isSuperAdmin: false, roles: [], groups: [] });
    expect(isInAnyGroup(['BA'])).toBe(false);
  });
});
