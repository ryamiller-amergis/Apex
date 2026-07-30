import { resolveAccessibleRoute, type AccessibleRouteContext } from '../accessibleRoute';

const base: AccessibleRouteContext = {
  canAccessHome: false,
  can: () => false,
  isSuperAdmin: false,
  enabledViews: [],
  selectedProject: 'MyProject',
  isInAnyGroup: () => false,
};

describe('resolveAccessibleRoute', () => {
  describe('Home-first', () => {
    it('returns /home when canAccessHome is true', () => {
      expect(resolveAccessibleRoute({ ...base, canAccessHome: true })).toBe('/home');
    });

    it('prefers /home over any module even when modules are also accessible', () => {
      const result = resolveAccessibleRoute({
        ...base,
        canAccessHome: true,
        can: () => true,
        enabledViews: ['calendar', 'planning'],
      });
      expect(result).toBe('/home');
    });
  });

  describe('Home disabled — first accessible module', () => {
    it('returns /calendar when calendar is the first accessible module', () => {
      const result = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'calendar:view',
        enabledViews: ['calendar'],
      });
      expect(result).toBe('/calendar');
    });

    it('skips calendar and returns /planning when only planning is accessible', () => {
      const result = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'planning:view',
        enabledViews: ['planning'],
      });
      expect(result).toBe('/planning/dev-stats');
    });

    it('returns /backlog over later modules when calendar/planning lack menu access', () => {
      const result = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'interviews:view',
        enabledViews: ['backlog'],
      });
      expect(result).toBe('/backlog');
    });
  });

  describe('Group-restricted modules', () => {
    it('returns /my-work only when Developer group membership is present', () => {
      const withGroup = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'dev-workbench:view',
        enabledViews: ['my-work'],
        isInAnyGroup: (groups) => groups.includes('Developer'),
      });
      expect(withGroup).toBe('/my-work');
    });

    it('skips /my-work when not in Developer group', () => {
      const result = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'dev-workbench:view',
        enabledViews: ['my-work'],
        isInAnyGroup: () => false,
      });
      expect(result).toBe('/');
    });

    it('returns /ui-lab only when UI/UX group membership is present', () => {
      const withGroup = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'ui-lab:view',
        enabledViews: ['ui-lab'],
        isInAnyGroup: (groups) => groups.includes('UI/UX'),
      });
      expect(withGroup).toBe('/ui-lab');
    });
  });

  describe('Project-restricted modules', () => {
    it('returns /feature-requests only when selectedProject is Apex', () => {
      const apexResult = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'feature-requests:view',
        enabledViews: ['feature-requests'],
        selectedProject: 'Apex',
      });
      expect(apexResult).toBe('/feature-requests');
    });

    it('skips /feature-requests when project is not Apex', () => {
      const result = resolveAccessibleRoute({
        ...base,
        can: (k) => k === 'feature-requests:view',
        enabledViews: ['feature-requests'],
        selectedProject: 'OtherProject',
      });
      expect(result).toBe('/');
    });
  });

  describe('Super admin', () => {
    it('returns /calendar as first module for super admin regardless of permissions or enabledViews', () => {
      const result = resolveAccessibleRoute({
        ...base,
        isSuperAdmin: true,
        can: () => false,
        enabledViews: [],
      });
      expect(result).toBe('/calendar');
    });

    it('super admin with canAccessHome still returns /home first', () => {
      const result = resolveAccessibleRoute({
        ...base,
        isSuperAdmin: true,
        canAccessHome: true,
        can: () => false,
        enabledViews: [],
      });
      expect(result).toBe('/home');
    });
  });

  describe('No accessible route', () => {
    it('returns / when no module is accessible and Home is disabled', () => {
      const result = resolveAccessibleRoute({
        ...base,
        canAccessHome: false,
        can: () => false,
        isSuperAdmin: false,
        enabledViews: [],
      });
      expect(result).toBe('/');
    });

    it('returns / when every module lacks menu enablement', () => {
      const result = resolveAccessibleRoute({
        ...base,
        can: () => true,
        enabledViews: [],
      });
      expect(result).toBe('/');
    });
  });
});
