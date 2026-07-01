import { Router, Request, Response } from 'express';
import {
  createSession,
  subscribeToSession,
  sendMessage,
  getSessionMessages,
  closeSession,
} from '../services/askApexService';
import { getUserId } from '../utils/requestUser';

const router = Router();

/**
 * POST /api/ask-apex/sessions
 * Create a new Ask Apex chat session.
 */
router.post('/sessions', (req: Request, res: Response) => {
  try {
    const sessionId = createSession(getUserId(req));
    res.status(201).json({ sessionId });
  } catch (err: any) {
    console.error('[ask-apex] createSession error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to create session' });
  }
});

/**
 * GET /api/ask-apex/sessions/:id/stream
 * SSE stream for real-time chat events.
 */
router.get('/sessions/:id/stream', (req: Request, res: Response) => {
  const userId = getUserId(req);
  const sessionId = req.params.id;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event: object) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay existing messages
  const messages = getSessionMessages(sessionId, userId);
  if (messages) {
    for (const msg of messages) {
      sendEvent({ type: 'message', message: msg });
    }
  }

  const unsubscribe = subscribeToSession(sessionId, userId, sendEvent);
  if (!unsubscribe) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'Session not found' })}\n\n`);
    res.end();
    return;
  }

  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

/**
 * POST /api/ask-apex/sessions/:id/messages
 * Send a user message. Response streams via SSE.
 */
router.post('/sessions/:id/messages', async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const sessionId = req.params.id;
  const { text } = req.body as { text?: string };

  if (!text?.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  res.status(202).json({ ok: true });
  sendMessage(sessionId, userId, text).catch((err) => {
    console.error(`[ask-apex] sendMessage error for session ${sessionId}:`, err.message);
  });
});

/**
 * DELETE /api/ask-apex/sessions/:id
 * Close and clean up a session.
 */
router.delete('/sessions/:id', (req: Request, res: Response) => {
  const userId = getUserId(req);
  const closed = closeSession(req.params.id, userId);
  res.json({ ok: closed });
});

export default router;
