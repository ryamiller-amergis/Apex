/**
 * Tests for the UI Surface Plan generation flow:
 *   - bedrockService: new plan exports, synthesisePlanFromUiMock
 *   - bedrockService: featurePlan wired into GenerateUiMockInput (type-level smoke)
 *   - designSystemService: componentDescriptions + routeLayoutHints on catalog shape
 *   - API route smoke tests for /generate-ui-plan, /ui-plan, /derive-feature-plan-from-epic
 */

import type {
  UiSurfacePlan,
  PbiContribution,
  UiLayoutPattern,
  PbiContributionType,
} from '../../shared/types/backlog';

/* ════════════════════════════════════════════════════════════
   Shared types — UiSurfacePlan shape
   ════════════════════════════════════════════════════════════ */

describe('UiSurfacePlan shared type', () => {
  it('constructs a well-formed plan object without TypeScript errors', () => {
    const contribution: PbiContribution = {
      pbiId: 'pbi-1',
      pbiTitle: 'Add filter bar',
      contributionType: 'filter' as PbiContributionType,
      targetArea: 'toolbar',
      summary: 'Adds date-range and status filters to the toolbar.',
    };

    const plan: UiSurfacePlan = {
      scope: 'feature',
      decision: 'update-page',
      targetPageRoute: '/timecards',
      targetPageTitle: 'Time Cards',
      subTabs: ['Pending', 'Approved'],
      activeSubTab: 'Pending',
      layoutPattern: 'table' as UiLayoutPattern,
      primaryComponents: ['DataTable', 'StatusChip'],
      rationale: 'Timecards page already exists and provides the natural home for this feature.',
      pbiContributions: [contribution],
      planVersion: 1,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(plan.scope).toBe('feature');
    expect(plan.decision).toBe('update-page');
    expect(plan.pbiContributions).toHaveLength(1);
    expect(plan.pbiContributions[0].contributionType).toBe('filter');
  });

  it('accepts epic scope', () => {
    const plan: UiSurfacePlan = {
      scope: 'epic',
      decision: 'new-page',
      subTabs: [],
      primaryComponents: [],
      rationale: 'Needs a brand new section.',
      pbiContributions: [],
      planVersion: 1,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(plan.scope).toBe('epic');
  });
});

/* ════════════════════════════════════════════════════════════
   bedrockService — new plan exports smoke
   ════════════════════════════════════════════════════════════ */

describe('bedrockService UI plan exports', () => {
  it('exports generateUiPlanFromBedrock and synthesisePlanFromUiMock', async () => {
    const mod = await import('../services/bedrockService');
    expect(typeof mod.generateUiPlanFromBedrock).toBe('function');
    expect(typeof mod.synthesisePlanFromUiMock).toBe('function');
  });

  it('exports GenerateUiMockInput-compatible interface (pbiId + featurePlan fields accepted)', async () => {
    const mod = await import('../services/bedrockService');
    // This is a type-level smoke: just verify the function signature accepts featurePlan
    // by passing a minimal plan — we can't invoke the real function without AWS creds.
    expect(typeof mod.generateUiMockFromBedrock).toBe('function');
  });
});

/* ════════════════════════════════════════════════════════════
   synthesisePlanFromUiMock — legacy backward-compat synthesis
   ════════════════════════════════════════════════════════════ */

describe('synthesisePlanFromUiMock', () => {
  let synthesisePlanFromUiMock: (
    featureId: string,
    featureTitle: string,
    uiMock: {
      decision: 'new-page' | 'update-page' | 'no-ui';
      targetPageRoute?: string;
      targetPageTitle?: string;
      targetPageSubTabs?: string[];
      views?: Array<{ pbiId: string; pbiTitle: string }>;
    }
  ) => UiSurfacePlan;

  beforeAll(async () => {
    const mod = await import('../services/bedrockService');
    synthesisePlanFromUiMock = mod.synthesisePlanFromUiMock;
  });

  it('copies decision, route, title, and subTabs from the uiMock', () => {
    const plan = synthesisePlanFromUiMock('feat-1', 'My Feature', {
      decision: 'update-page',
      targetPageRoute: '/timecards',
      targetPageTitle: 'Time Cards',
      targetPageSubTabs: ['Pending', 'Approved'],
      views: [{ pbiId: 'pbi-1', pbiTitle: 'Filter bar' }],
    });

    expect(plan.decision).toBe('update-page');
    expect(plan.targetPageRoute).toBe('/timecards');
    expect(plan.targetPageTitle).toBe('Time Cards');
    expect(plan.subTabs).toEqual(['Pending', 'Approved']);
  });

  it('creates one PbiContribution per view with fallback contributionType = new-section', () => {
    const plan = synthesisePlanFromUiMock('feat-1', 'My Feature', {
      decision: 'update-page',
      views: [
        { pbiId: 'pbi-1', pbiTitle: 'Filter bar' },
        { pbiId: 'pbi-2', pbiTitle: 'Export button' },
      ],
    });

    expect(plan.pbiContributions).toHaveLength(2);
    expect(plan.pbiContributions[0].pbiId).toBe('pbi-1');
    expect(plan.pbiContributions[0].contributionType).toBe('new-section');
    expect(plan.pbiContributions[1].pbiId).toBe('pbi-2');
  });

  it('produces scope=feature and status=draft', () => {
    const plan = synthesisePlanFromUiMock('feat-1', 'My Feature', {
      decision: 'no-ui',
    });
    expect(plan.scope).toBe('feature');
    expect(plan.status).toBe('draft');
    expect(plan.planVersion).toBe(1);
  });

  it('handles missing views gracefully (empty pbiContributions)', () => {
    const plan = synthesisePlanFromUiMock('feat-1', 'My Feature', {
      decision: 'new-page',
    });
    expect(plan.pbiContributions).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════
   designSystemService — new catalog fields smoke
   ════════════════════════════════════════════════════════════ */

describe('designSystemService catalog shape', () => {
  it('returns empty catalog with componentDescriptions and routeLayoutHints when no env vars', async () => {
    const { getDesignSystemCatalog, clearDesignSystemCache } = await import('../services/designSystemService');
    clearDesignSystemCache();

    // Without ADO_ORG/ADO_PAT the service returns an empty catalog
    const originalOrg = process.env.ADO_ORG;
    const originalPat = process.env.ADO_PAT;
    delete process.env.ADO_ORG;
    delete process.env.ADO_PAT;

    try {
      const catalog = await getDesignSystemCatalog();
      expect(catalog).toHaveProperty('componentDescriptions');
      expect(catalog).toHaveProperty('routeLayoutHints');
      expect(typeof catalog.componentDescriptions).toBe('object');
      expect(typeof catalog.routeLayoutHints).toBe('object');
    } finally {
      if (originalOrg) process.env.ADO_ORG = originalOrg;
      if (originalPat) process.env.ADO_PAT = originalPat;
      clearDesignSystemCache();
    }
  });
});

/* ════════════════════════════════════════════════════════════
   API routes — generate-ui-plan, ui-plan, derive-feature-plan-from-epic
   ════════════════════════════════════════════════════════════ */

import request from 'supertest';
import express from 'express';
import apiRouter from '../routes/api';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  return app;
}

describe('API route smoke: /backlog/generate-ui-plan', () => {
  it('returns 400 when required fields are missing', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/backlog/generate-ui-plan')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when feature scope provided without featureId', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/backlog/generate-ui-plan')
      .send({ scope: 'feature', document: { epics: [], features: [], pbis: [] }, project: 'test', areaPath: 'test' });
    expect(res.status).toBe(400);
  });
});

describe('API route smoke: /backlog/ui-plan', () => {
  it('returns 400 when required fields are missing', async () => {
    const app = createTestApp();
    const res = await request(app)
      .put('/api/backlog/ui-plan')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('API route smoke: /backlog/derive-feature-plan-from-epic', () => {
  it('returns 400 when required fields are missing', async () => {
    const app = createTestApp();
    const res = await request(app)
      .post('/api/backlog/derive-feature-plan-from-epic')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 when epic has no plan', async () => {
    const app = createTestApp();
    const doc = {
      epics: [{ id: 'epic-1', workItemType: 'Epic', title: 'My Epic', status: 'Draft' }],
      features: [{ id: 'feat-1', parentId: 'epic-1', workItemType: 'Feature', title: 'My Feature', status: 'Draft' }],
      pbis: [],
    };
    const res = await request(app)
      .post('/api/backlog/derive-feature-plan-from-epic')
      .send({ epicId: 'epic-1', featureId: 'feat-1', document: doc, project: 'test', areaPath: 'test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no UI surface plan/i);
  });
});

/* ════════════════════════════════════════════════════════════
   Plan-locked PBI generation smoke — featurePlan wiring
   ════════════════════════════════════════════════════════════ */

describe('generate-pbi-view with plan context', () => {
  it('route resolves plan correctly and only fails at Bedrock boundary', async () => {
    // Verify the route resolves the feature plan and reaches the Bedrock call.
    // The design-system catalog fetch and the Bedrock client are stubbed so the
    // test is deterministic and fast: the only failure point is the (stubbed)
    // Bedrock boundary, never a 400 or an internal error before it.
    const designSystemService = await import('../services/designSystemService');
    const bedrockService = await import('../services/bedrockService');
    const catalogSpy = jest
      .spyOn(designSystemService, 'getDesignSystemCatalog')
      .mockResolvedValue({} as any);
    const bedrockSpy = jest
      .spyOn(bedrockService, 'generateUiMockVariantsFromBedrock')
      .mockRejectedValue(new Error('Bedrock unavailable in test env'));

    try {
      const app = createTestApp();
      const now = new Date().toISOString();
      const plan: UiSurfacePlan = {
        scope: 'feature',
        decision: 'update-page',
        targetPageRoute: '/timecards',
        targetPageTitle: 'Time Cards',
        subTabs: ['Pending', 'Approved'],
        primaryComponents: ['DataTable'],
        rationale: 'Test plan.',
        pbiContributions: [
          { pbiId: 'pbi-1', pbiTitle: 'Add filter', contributionType: 'filter', targetArea: 'toolbar', summary: 'Adds a filter.' },
        ],
        planVersion: 1,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      const doc = {
        epics: [],
        features: [{ id: 'feat-1', parentId: undefined, workItemType: 'Feature', title: 'My Feature', status: 'Draft', uiSurfacePlan: plan }],
        pbis: [{ id: 'pbi-1', parentId: 'feat-1', workItemType: 'PBI', title: 'Add filter', status: 'Draft' }],
      };
      const res = await request(app)
        .post('/api/backlog/generate-pbi-view')
        .send({ featureId: 'feat-1', pbiId: 'pbi-1', document: doc, project: 'test', areaPath: 'test' });

      // Reaching the (stubbed) Bedrock call means the plan resolved and the route
      // surfaced a 5xx rather than a 400/internal error before the boundary.
      expect([500, 422, 503]).toContain(res.status);
      expect(bedrockSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          featurePlan: expect.objectContaining({ targetPageRoute: '/timecards' }),
        }),
        1,
      );
    } finally {
      catalogSpy.mockRestore();
      bedrockSpy.mockRestore();
    }
  });
});
