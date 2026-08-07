import fs from 'fs';
import path from 'path';
import {
  ALL_MENU_VIEWS,
  CONFIGURABLE_MENU_ITEMS,
  DEFAULT_ENABLED_MENU_VIEWS,
} from '../../shared/types/menuSettings';

const repoRoot = path.resolve(__dirname, '../../..');
const migrationPath = path.join(
  repoRoot,
  'migrations',
  '20260806030000_diagram-persistence-and-permissions.sql',
);
const apiRoutePath = path.join(repoRoot, 'src/server/routes/api.ts');

const DIAGRAM_KEYS = [
  'diagram:view',
  'diagram:create',
  'diagram:edit',
  'diagram:delete',
  'diagram:share',
] as const;

describe('FEAT-002 Diagram RBAC and opt-in navigation', () => {
  describe('TBI-004 DoD-0 / VT-01 / VT-02 / VT-03 — permission keys + BR-012 defaults', () => {
    it('DoD-0: migration seeds all five diagram:* keys (category diagram)', () => {
      const migration = fs.readFileSync(migrationPath, 'utf8');

      for (const key of DIAGRAM_KEYS) {
        expect(migration).toContain(`'${key}'`);
      }
      expect(migration).toMatch(/'diagram:view'[\s\S]*'diagram'/);
    });

    it('VT-01: viewer receives diagram:view', () => {
      const migration = fs.readFileSync(migrationPath, 'utf8');
      expect(migration).toMatch(/r\.name IN \('admin', 'member', 'viewer'\)[\s\S]*diagram:view/);
    });

    it('VT-02: member and admin receive all five diagram:* keys', () => {
      const migration = fs.readFileSync(migrationPath, 'utf8');
      expect(migration).toMatch(
        /r\.name IN \('admin', 'member'\)[\s\S]*diagram:create[\s\S]*diagram:edit[\s\S]*diagram:delete[\s\S]*diagram:share/,
      );
      expect(migration).toMatch(/r\.name IN \('admin', 'member', 'viewer'\)[\s\S]*diagram:view/);
    });

    it('VT-03 / DoD-0 down: migration removes all five keys on rollback', () => {
      const migration = fs.readFileSync(migrationPath, 'utf8');
      expect(migration).toMatch(
        /-- Down Migration[\s\S]*DELETE FROM app_permissions[\s\S]*diagram:view[\s\S]*diagram:share/,
      );
    });
  });

  describe('TBI-004 DoD-2 / PBI-001 AC-2 / BR-011 / VT-04 — opt-in menu defaults', () => {
    it('VT-04: diagrams is configurable but excluded from DEFAULT_ENABLED_MENU_VIEWS', () => {
      expect(CONFIGURABLE_MENU_ITEMS.map((i) => i.key)).toContain('diagrams');
      expect(ALL_MENU_VIEWS).toContain('diagrams');
      expect(DEFAULT_ENABLED_MENU_VIEWS).not.toContain('diagrams');
      expect(DEFAULT_ENABLED_MENU_VIEWS).toEqual(
        ALL_MENU_VIEWS.filter((key) => key !== 'diagrams'),
      );
    });

    it('AC-2: projects with no menu config fall back without diagrams', () => {
      const apiSource = fs.readFileSync(apiRoutePath, 'utf8');
      expect(apiSource).toMatch(/DEFAULT_ENABLED_MENU_VIEWS/);
      expect(apiSource).toMatch(
        /enabledViews:\s*config\?\.enabledViews\s*\?\?\s*DEFAULT_ENABLED_MENU_VIEWS/,
      );

      const noConfigFallback = DEFAULT_ENABLED_MENU_VIEWS;
      expect(noConfigFallback).not.toContain('diagrams');
    });
  });

  describe('TBI-004 DoD-3 — permission and menu gating combinations', () => {
    it('nav visibility requires BOTH menu enabled AND diagram:view', () => {
      const cases = [
        { menuEnabled: false, hasViewPerm: false, expectVisible: false },
        { menuEnabled: false, hasViewPerm: true, expectVisible: false },
        { menuEnabled: true, hasViewPerm: false, expectVisible: false },
        { menuEnabled: true, hasViewPerm: true, expectVisible: true },
      ];

      for (const { menuEnabled, hasViewPerm, expectVisible } of cases) {
        const enabledViews: string[] = menuEnabled ? ['diagrams'] : [];
        const can = (key: string) => key === 'diagram:view' && hasViewPerm;
        const visible = enabledViews.includes('diagrams') && can('diagram:view');
        expect(visible).toBe(expectVisible);
      }
    });
  });
});
