import { Router, Request, Response } from 'express';
import { getUserId } from '../utils/requestUser';
import * as featureFlagService from '../services/featureFlagService';

const router = Router();

router.get('/evaluate', async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getUserId(req);
    const project = req.query.project as string;
    if (!userId || userId === 'anonymous') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!project) {
      res.status(400).json({ error: 'project query parameter is required' });
      return;
    }
    const groupIds = await featureFlagService.getUserGroupIdsForProject(userId, project);
    const flags = await featureFlagService.evaluateFlags({ userId, project, groupIds });
    res.json({ flags });
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
