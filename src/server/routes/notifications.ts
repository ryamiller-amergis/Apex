import { Router } from 'express';
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getPreferences,
  upsertPreference,
  subscribe,
  unsubscribe,
} from '../services/notificationService';
import { getUserId } from '../utils/requestUser';
import type { NotificationType } from '../../shared/types/notification';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const userId = getUserId(req);
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;
    const items = await getNotifications(userId, { limit, offset });
    res.json(items);
  } catch (err) {
    console.error('[notifications] GET / error:', err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.get('/stream', (req, res) => {
  const userId = getUserId(req);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  subscribe(userId, res);

  req.on('close', () => {
    unsubscribe(userId, res);
  });
});

router.patch('/:id/read', async (req, res) => {
  try {
    const userId = getUserId(req);
    await markAsRead(userId, req.params.id);
    res.sendStatus(204);
  } catch (err) {
    console.error('[notifications] PATCH /:id/read error:', err);
    res.status(500).json({ error: 'Failed to mark notification as read' });
  }
});

router.patch('/read-all', async (req, res) => {
  try {
    const userId = getUserId(req);
    await markAllAsRead(userId);
    res.sendStatus(204);
  } catch (err) {
    console.error('[notifications] PATCH /read-all error:', err);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

router.get('/unread-count', async (req, res) => {
  try {
    const userId = getUserId(req);
    const cnt = await getUnreadCount(userId);
    res.json({ count: cnt });
  } catch (err) {
    console.error('[notifications] GET /unread-count error:', err);
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

router.get('/preferences', async (req, res) => {
  try {
    const userId = getUserId(req);
    const prefs = await getPreferences(userId);
    res.json(prefs);
  } catch (err) {
    console.error('[notifications] GET /preferences error:', err);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

router.patch('/preferences', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { notificationType, enabled, toastEnabled } = req.body as {
      notificationType: NotificationType;
      enabled?: boolean;
      toastEnabled?: boolean;
    };

    if (!notificationType) {
      return res.status(400).json({ error: 'notificationType is required' });
    }

    await upsertPreference(userId, notificationType, { enabled, toastEnabled });
    res.sendStatus(204);
  } catch (err) {
    console.error('[notifications] PATCH /preferences error:', err);
    res.status(500).json({ error: 'Failed to update preference' });
  }
});

export default router;
