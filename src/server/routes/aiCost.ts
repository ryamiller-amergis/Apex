import { Router, type Request, type Response } from 'express';
import { requirePermission, requireProjectAccess } from '../middleware/rbac';
import { isSuperAdminRequest } from '../utils/superAdmin';
import * as analytics from '../services/aiCostAnalyticsService';
import { getForecast } from '../services/aiCostForecastService';
import { generateInsightsForProject } from '../services/aiCostInsightsService';
import { getLatestDailyBrief, generateDailyBrief } from '../services/aiCostDailyBriefService';
import { db } from '../db/drizzle';
import { aiPricing } from '../db/schema';
import { eq } from 'drizzle-orm';

const router = Router();

router.use(requirePermission('analytics:ai-cost:view'));

function getProjectParam(req: Request): string | undefined {
  return (req.query.project as string) || undefined;
}

function getDateFilter(req: Request) {
  const to = (req.query.to as string) || new Date().toISOString();
  const from = (req.query.from as string) || (() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  })();
  return {
    from,
    to,
    project: (req.query.project as string) || undefined,
    feature: (req.query.feature as string) || undefined,
    model: (req.query.model as string) || undefined,
    provider: (req.query.provider as string) || undefined,
  };
}

// GET /api/ai-cost/summary
router.get(
  '/summary',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const f = getDateFilter(req);
      const summary = await analytics.getSummary(f);
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch summary' });
    }
  },
);

// GET /api/ai-cost/timeseries
router.get(
  '/timeseries',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const f = getDateFilter(req);
      const data = await analytics.getTimeseries(f);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch timeseries' });
    }
  },
);

// GET /api/ai-cost/by-feature
router.get(
  '/by-feature',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const f = getDateFilter(req);
      const data = await analytics.getByFeature(f);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch by-feature' });
    }
  },
);

// GET /api/ai-cost/by-model
router.get(
  '/by-model',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const f = getDateFilter(req);
      const data = await analytics.getByModel(f);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch by-model' });
    }
  },
);

// GET /api/ai-cost/comparison — super admin only, cross-project comparison with nested features
router.get(
  '/comparison',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const f = getDateFilter(req);
      const data = await analytics.getProjectComparison({ from: f.from, to: f.to });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch comparison' });
    }
  },
);

// GET /api/ai-cost/by-project — super admin only
router.get(
  '/by-project',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const f = getDateFilter(req);
      const data = await analytics.getByProject(f);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch by-project' });
    }
  },
);

// GET /api/ai-cost/by-user — super admin only
router.get(
  '/by-user',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const f = getDateFilter(req);
      const data = await analytics.getByUser(f);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch by-user' });
    }
  },
);

// GET /api/ai-cost/events
router.get(
  '/events',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const f = getDateFilter(req);
      const page = parseInt(req.query.page as string || '1', 10);
      const pageSize = Math.min(parseInt(req.query.pageSize as string || '25', 10), 100);
      const data = await analytics.getEvents(f, page, pageSize);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch events' });
    }
  },
);

// GET /api/ai-cost/reconciliation
router.get(
  '/reconciliation',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const f = getDateFilter(req);
      const data = await analytics.getReconciliation(f);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch reconciliation' });
    }
  },
);

// GET /api/ai-cost/forecast
router.get(
  '/forecast',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const project = (req.query.project as string) ?? 'all';
      const data = await getForecast(project);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch forecast' });
    }
  },
);

// GET /api/ai-cost/insights
router.get(
  '/insights',
  requireProjectAccess(getProjectParam),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const project = (req.query.project as string) ?? 'all';
      const to = new Date().toISOString().split('T')[0]!;
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30);
      const from = fromDate.toISOString().split('T')[0]!;

      const cached = await analytics.getCachedInsights(project, from, to);
      if (cached) {
        res.json(cached);
        return;
      }
      res.json({
        project,
        periodFrom: from,
        periodTo: to,
        modelUsed: '',
        headline: null,
        insights: [],
        recommendations: [],
        riskFlags: [],
        generatedAt: null,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch insights' });
    }
  },
);

// POST /api/ai-cost/insights/refresh — triggers immediate insights generation and waits
router.post(
  '/insights/refresh',
  async (req: Request, res: Response): Promise<void> => {
    const project = (req.body?.project as string) || (req.query.project as string);
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    try {
      await generateInsightsForProject(project);
      res.json({ message: 'Insights generated successfully' });
    } catch (err) {
      console.error('[aiCost] Insights refresh failed:', err);
      res.status(500).json({ error: 'Insights generation failed', detail: (err as Error).message });
    }
  },
);

// POST /api/ai-cost/sync — super admin only, triggers immediate billing sync + allocation
router.post(
  '/sync',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      // Run async — respond immediately so UI can show loading state
      (async () => {
        const { runCursorBillingSync } = await import('../services/cursorBillingSyncService');
        const { runCostAllocation } = await import('../services/aiCostAllocationService');
        await runCursorBillingSync();
        await runCostAllocation();
        console.log('[aiCost] Manual sync complete');
      })().catch((err) => console.error('[aiCost] Manual sync error:', err));

      res.json({ message: 'Sync started — data will update within ~30 seconds' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to start sync' });
    }
  },
);

// GET /api/ai-cost/daily-brief — super admin only
router.get(
  '/daily-brief',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const project = (req.query.project as string) ?? 'all';
      const briefType = (req.query.type as 'morning' | 'afternoon') || undefined;
      const brief = await getLatestDailyBrief(project, briefType);
      res.json(brief ?? null);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch daily brief' });
    }
  },
);

// POST /api/ai-cost/daily-brief/generate — super admin, triggers immediate generation
router.post(
  '/daily-brief/generate',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    const project = (req.body?.project as string) || (req.query.project as string);
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    try {
      await generateDailyBrief(project);
      const brief = await getLatestDailyBrief(project);
      res.json(brief);
    } catch (err) {
      console.error('[aiCost] Daily brief generation failed:', err);
      res.status(500).json({ error: 'Brief generation failed', detail: (err as Error).message });
    }
  },
);
router.get(
  '/pricing',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const data = await analytics.getPricing();
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch pricing' });
    }
  },
);

// PUT /api/ai-cost/pricing/:id — super admin only
router.put(
  '/pricing/:id',
  async (req: Request, res: Response): Promise<void> => {
    if (!isSuperAdminRequest(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    try {
      const { inputPricePerMtok, outputPricePerMtok, cacheReadPricePerMtok, cacheWritePricePerMtok } = req.body;
      await db.update(aiPricing)
        .set({
          inputPricePerMtok: String(inputPricePerMtok),
          outputPricePerMtok: String(outputPricePerMtok),
          cacheReadPricePerMtok: String(cacheReadPricePerMtok),
          cacheWritePricePerMtok: String(cacheWritePricePerMtok),
        })
        .where(eq(aiPricing.id, req.params.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to update pricing' });
    }
  },
);

export default router;
