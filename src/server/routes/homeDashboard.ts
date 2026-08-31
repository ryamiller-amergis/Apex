import { Router, type Request, type Response } from 'express';
import { requirePermission, requireProjectAccess, resolveRequestProject } from '../middleware/rbac';
import { getHomeDashboard } from '../services/homeDashboardService';
import { getUserId } from '../utils/requestUser';
import { isSuperAdminRequest } from '../utils/superAdmin';

const router = Router();

// GET /api/home-dashboard — tile payload for the authenticated user in one project.
// Per-tile permission gates live in the service; this route only enforces access
// to the dashboard itself.
router.get(
  '/',
  requirePermission('home:view'),
  requireProjectAccess(resolveRequestProject),
  async (req: Request, res: Response): Promise<void> => {
    const project = resolveRequestProject(req);
    // Super admins bypass requireProjectAccess, including its `all` sentinel check,
    // but the dashboard is always scoped to a single project.
    if (!project || project === 'all') {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    try {
      const payload = await getHomeDashboard({
        userId: getUserId(req),
        project,
        isSuperAdmin: isSuperAdminRequest(req),
      });
      res.json(payload);
    } catch (err) {
      console.error('[home-dashboard] GET / error:', err);
      res.status(500).json({ error: 'Failed to fetch home dashboard' });
    }
  },
);

export default router;
