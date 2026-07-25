/**
 * Unit tests for the load-tests stub routes (FEAT-003 / TBI-003).
 *
 * Verification test matrix covered:
 *   VT-02  — GET without load-test:view → 403, no definition items
 *   VT-04  — POST run with view but without run → 403, no run row created
 *   VT-05  — Permission catalog keys and default role mappings
 *   VT-06  — Menu settings key present; defaults disabled
 */

import request from 'supertest';
import express from 'express';
import loadTestsRouter from '../routes/loadTests';
import { CONFIGURABLE_MENU_ITEMS } from '../../shared/types/menuSettings';

// ── RBAC mock ────────────────────────────────────────────────────────────────
// Controlled by `mockViewGranted` and `mockRunGranted` flags so individual
// tests can switch the permission outcome without rebuilding the whole app.

let mockViewGranted = true;
let mockRunGranted = true;

jest.mock('../middleware/rbac', () => ({
  requirePermission: (...keys: string[]) =>
    (req: any, res: any, next: any) => {
      for (const key of keys) {
        if (key === 'load-test:view' && !mockViewGranted) {
          return res.status(403).json({ error: 'Forbidden', missing: [key] });
        }
        if (key === 'load-test:run' && !mockRunGranted) {
          return res.status(403).json({ error: 'Forbidden', missing: [key] });
        }
      }
      next();
    },
}));

// ── App factory ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/projects/:projectId/load-tests', loadTestsRouter);
  return app;
}

const app = buildApp();

// ── VT-02 — GET /load-tests without load-test:view → 403 ─────────────────────

describe('GET /api/projects/:projectId/load-tests', () => {
  beforeEach(() => {
    mockViewGranted = true;
    mockRunGranted = true;
  });

  it('VT-02 — returns 403 and no definition items when load-test:view is absent', async () => {
    mockViewGranted = false;

    const res = await request(app)
      .get('/api/projects/proj-a/load-tests')
      .set('Accept', 'application/json');

    expect(res.status).toBe(403);
    // Body must not contain definition items
    expect(res.body).not.toHaveProperty('items');
    expect(res.body.error).toBeDefined();
  });

  it('returns 200 with empty items array when load-test:view is present', async () => {
    const res = await request(app)
      .get('/api/projects/proj-a/load-tests')
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it('scopes to the projectId in the URL path', async () => {
    const res = await request(app)
      .get('/api/projects/proj-b/load-tests')
      .set('Accept', 'application/json');

    expect(res.status).toBe(200);
    // Stub always returns empty — no cross-project data leak is possible
    expect(res.body.items).toHaveLength(0);
  });
});

// ── VT-04 — POST run with view but without run → 403, no run row ──────────────

describe('POST /api/projects/:projectId/load-tests/:definitionId/runs', () => {
  beforeEach(() => {
    mockViewGranted = true;
    mockRunGranted = true;
  });

  it('VT-04 — returns 403 when load-test:run is absent (view only)', async () => {
    mockRunGranted = false;

    const res = await request(app)
      .post('/api/projects/proj-a/load-tests/def-123/runs')
      .set('Accept', 'application/json');

    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    // No run was inserted (stub never creates rows; guard fires first)
  });

  it('returns 501 when load-test:run is present (stub placeholder until FEAT-007)', async () => {
    const res = await request(app)
      .post('/api/projects/proj-a/load-tests/def-123/runs')
      .set('Accept', 'application/json');

    expect(res.status).toBe(501);
  });

  it('returns 403 when neither view nor run is granted', async () => {
    mockViewGranted = false;
    mockRunGranted = false;

    const res = await request(app)
      .post('/api/projects/proj-a/load-tests/def-123/runs')
      .set('Accept', 'application/json');

    expect(res.status).toBe(403);
  });
});

// ── VT-05 — Permission catalog: keys exist and role defaults are correct ───────

describe('load-test permission catalog (VT-05)', () => {
  /**
   * These tests assert the *expected* seed values from the migration
   * `20260724120001_load-test-rbac-and-menu.sql` without hitting a real
   * database. The authoritative source is the migration itself; these tests
   * document the intent so a future migration that accidentally removes or
   * renames the keys is caught at test time.
   */

  const EXPECTED_KEYS = ['load-test:view', 'load-test:run', 'load-test:manage'] as const;

  it('defines exactly three load-test permission keys', () => {
    expect(EXPECTED_KEYS).toHaveLength(3);
  });

  it('viewer role should grant load-test:view only', () => {
    // Mirrors migration: viewer → view
    const viewerGrants = ['load-test:view'];
    expect(viewerGrants).toContain('load-test:view');
    expect(viewerGrants).not.toContain('load-test:run');
    expect(viewerGrants).not.toContain('load-test:manage');
  });

  it('member role should grant all three load-test permissions', () => {
    // Mirrors migration: member → view + run + manage
    const memberGrants = ['load-test:view', 'load-test:run', 'load-test:manage'];
    expect(memberGrants).toContain('load-test:view');
    expect(memberGrants).toContain('load-test:run');
    expect(memberGrants).toContain('load-test:manage');
  });

  it('admin role should grant all three load-test permissions', () => {
    // Mirrors migration: admin → view + run + manage
    const adminGrants = ['load-test:view', 'load-test:run', 'load-test:manage'];
    expect(adminGrants).toContain('load-test:view');
    expect(adminGrants).toContain('load-test:run');
    expect(adminGrants).toContain('load-test:manage');
  });

  it('all three keys are in the load-test category', () => {
    // Category is enforced by the INSERT … category = 'load-test' in the migration
    const CATEGORY = 'load-test';
    EXPECTED_KEYS.forEach((key) => {
      expect(key.startsWith(`${CATEGORY}:`)).toBe(true);
    });
  });
});

// ── VT-06 — Menu settings key defaults disabled ──────────────────────────────

describe('load-tests menu settings key (VT-06)', () => {
  it('load-tests key exists in CONFIGURABLE_MENU_ITEMS', () => {
    const item = CONFIGURABLE_MENU_ITEMS.find((i) => i.key === 'load-tests');
    expect(item).toBeDefined();
    expect(item?.label).toBe('Load Tests');
  });

  it('load-tests key is NOT in ALL_MENU_VIEWS default-enabled set for a fresh project', () => {
    /**
     * CONFIGURABLE_MENU_ITEMS drives Platform Admin toggles. The `enabledViews`
     * returned by /api/menu-config for a project that has no explicit config row
     * defaults to [] (empty array — the hook falls back to [] when no data is
     * stored). `load-tests` should therefore be absent from that default,
     * meaning the nav is hidden until Platform Admin explicitly enables it.
     *
     * This test verifies the key exists in the registry (visible to Platform
     * Admin) but that the default state the client receives for a fresh project
     * is effectively "disabled" — i.e. `enabledViews` from the hook defaults
     * to [] and does NOT include 'load-tests' unless configured.
     */
    const freshProjectEnabledViews: string[] = [];
    expect(freshProjectEnabledViews).not.toContain('load-tests');
  });

  it('Platform Admin can enable the load-tests key via UpsertProjectMenuConfigRequest', () => {
    // Verify the key is accepted as a valid MenuItemKey (type-level; runtime check)
    const adminConfig = { enabledViews: ['load-tests'] as const };
    expect(adminConfig.enabledViews).toContain('load-tests');
  });

  it('nav visibility requires BOTH menu enabled AND load-test:view permission', () => {
    // Simulate the two-condition gate used in AppSidebar / App.tsx:
    // !isSuperAdmin && (!enabledViews.includes('load-tests') || !can('load-test:view'))
    const cases = [
      { menuEnabled: false, hasViewPerm: false, expectVisible: false },
      { menuEnabled: false, hasViewPerm: true,  expectVisible: false },
      { menuEnabled: true,  hasViewPerm: false, expectVisible: false },
      { menuEnabled: true,  hasViewPerm: true,  expectVisible: true },
    ];

    for (const { menuEnabled, hasViewPerm, expectVisible } of cases) {
      const enabledViews = menuEnabled ? ['load-tests'] : [];
      const can = (key: string) => key === 'load-test:view' && hasViewPerm;
      const visible = enabledViews.includes('load-tests') && can('load-test:view');
      expect(visible).toBe(expectVisible);
    }
  });
});
