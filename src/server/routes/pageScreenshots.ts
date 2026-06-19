import { Router } from 'express';
import { requirePermission } from '../middleware/rbac';
import { getUserId } from '../utils/requestUser';
import {
  getScreenshotByRoute,
  upsertScreenshot,
  deleteScreenshot,
  listScreenshots,
} from '../services/pageScreenshotService';

const router = Router();

router.get('/', requirePermission('design-prototypes:review'), async (_req, res, next) => {
  try {
    const screenshots = await listScreenshots();
    res.json(screenshots);
  } catch (err) {
    next(err);
  }
});

router.get('/by-route', requirePermission('interviews:view'), async (req, res, next) => {
  try {
    const route = req.query.route as string;
    if (!route) {
      res.status(400).json({ error: 'route query parameter is required' });
      return;
    }
    const screenshot = await getScreenshotByRoute(route);
    if (!screenshot) {
      res.status(404).json({ error: 'No screenshot found for this route' });
      return;
    }
    res.json(screenshot);
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePermission('design-prototypes:review'), async (req, res, next) => {
  try {
    const userId = getUserId(req);
    const { url, imageBase64, mediaType } = req.body as {
      url?: string;
      imageBase64?: string;
      mediaType?: string;
    };

    if (!url || !imageBase64) {
      res.status(400).json({ error: 'url and imageBase64 are required' });
      return;
    }

    const screenshot = await upsertScreenshot(
      url,
      imageBase64,
      mediaType || 'image/png',
      userId,
    );
    res.status(201).json(screenshot);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('design-prototypes:review'), async (req, res, next) => {
  try {
    await deleteScreenshot(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
