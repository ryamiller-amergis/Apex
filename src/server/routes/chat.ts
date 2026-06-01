import { Router, Request, Response, NextFunction } from 'express';
import {
  createThread,
  listThreadSummaries,
  sendMessage,
  subscribeToThread,
  cancelRun,
  closeThread,
  readOutputPrd,
  readOutputBacklog,
  isPrdReady,
} from '../services/chatAgentService';
import { db } from '../db/drizzle';
import { eq } from 'drizzle-orm';
import { prds } from '../db/schema';
import { toggleFlag } from '../services/chatThreadRepository';
import { resolveThreadAccess, canWriteThread } from '../services/threadAccessService';
import { getUserId } from '../utils/requestUser';
import type { ChatAttachment, ChatThread, StartChatRequest, SendMessageRequest } from '../../shared/types/chat';
import type { ThreadAccess } from '../services/threadAccessService';
import { requirePermission } from '../middleware/rbac';

const router = Router();

router.use(requirePermission('chat:view'));
const MAX_CHAT_ATTACHMENTS = 5;
const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;

interface ThreadRequest extends Request {
  thread?: ChatThread;
  threadAccess?: ThreadAccess;
}

/**
 * Loads a thread when the user has read access (owner or document-scoped viewer).
 * Returns 404 when access is denied to avoid leaking thread existence.
 */
async function requireThreadRead(req: Request, res: Response, next: NextFunction): Promise<void> {
  const result = await resolveThreadAccess(getUserId(req), req.params.id);
  if (!result) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }
  const treq = req as ThreadRequest;
  treq.thread = result.thread;
  treq.threadAccess = result.access;
  next();
}

/**
 * Requires write access (thread owner, or assistant-thread approver/admin rules).
 */
async function requireThreadWrite(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = getUserId(req);
  const threadId = req.params.id;
  const result = await resolveThreadAccess(userId, threadId);
  if (!result) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }
  const allowed = await canWriteThread(userId, threadId);
  if (!allowed) {
    res.status(404).json({ error: 'Thread not found' });
    return;
  }
  const treq = req as ThreadRequest;
  treq.thread = result.thread;
  treq.threadAccess = result.access;
  next();
}

function readAttachments(raw: unknown): ChatAttachment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    const err = new Error('attachments must be an array');
    (err as any).status = 400;
    throw err;
  }
  if (raw.length > MAX_CHAT_ATTACHMENTS) {
    const err = new Error(`up to ${MAX_CHAT_ATTACHMENTS} attachments are allowed`);
    (err as any).status = 413;
    throw err;
  }

  let totalBytes = 0;
  return raw.map((attachment, index) => {
    const a = attachment as Partial<ChatAttachment>;
    if (!a.id || !a.name || typeof a.content !== 'string') {
      const err = new Error(`attachment ${index + 1} is invalid`);
      (err as any).status = 400;
      throw err;
    }
    const size = Number(a.size);
    if (!Number.isFinite(size) || size < 0) {
      const err = new Error(`attachment ${a.name} has an invalid size`);
      (err as any).status = 400;
      throw err;
    }
    if (size > MAX_CHAT_ATTACHMENT_BYTES) {
      const err = new Error(`attachment ${a.name} is too large`);
      (err as any).status = 413;
      throw err;
    }
    totalBytes += size;
    if (totalBytes > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
      const err = new Error('attachments are too large');
      (err as any).status = 413;
      throw err;
    }
    return {
      id: a.id,
      name: a.name,
      type: a.type ?? 'text/plain',
      size,
      content: a.content,
    };
  });
}

/**
 * GET /api/chat/threads
 * List thread summaries for the current user.
 * Query params: limit (default 50), offset (default 0)
 */
router.get('/threads', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  try {
    const summaries = await listThreadSummaries(getUserId(req), { limit, offset });
    res.json(summaries);
  } catch (err: any) {
    console.error('[chat] listThreadSummaries error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to list threads' });
  }
});

/**
 * POST /api/chat/threads
 * Start a new chat thread (clones the repo, injects context).
 * Body: StartChatRequest
 */
router.post('/threads', async (req: Request, res: Response) => {
  const body = req.body as Partial<StartChatRequest>;

  if (!body.kickoff?.project) return res.status(400).json({ error: 'kickoff.project is required' });
  if (!body.kickoff?.repo) return res.status(400).json({ error: 'kickoff.repo is required' });

  try {
    const thread = await createThread(getUserId(req), body.kickoff, {
      skipAutoKickoff: Boolean(body.skipAutoKickoff),
    });
    res.status(201).json({ threadId: thread.id });
  } catch (err: any) {
    console.error('[chat] createThread error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to create thread' });
  }
});

/**
 * GET /api/chat/threads/:id
 * Get thread metadata and message history (falls back to Postgres for historical threads).
 * Augments the response with a computed `prdReady` flag based on file existence.
 */
router.get('/threads/:id', requireThreadRead, (req: Request, res: Response) => {
  const thread = (req as any).thread as ChatThread;
  res.json({ ...thread, prdReady: isPrdReady(thread.id) });
});

/**
 * GET /api/chat/threads/:id/stream
 * Server-Sent Events stream for real-time agent output.
 */
router.get('/threads/:id/stream', requireThreadRead, (req: Request, res: Response) => {
  const thread = (req as any).thread as ChatThread;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  const sendEvent = (event: object) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Replay all existing messages so late-joining subscribers (including
  // the very first connect right after thread creation) never miss events.
  for (const msg of thread.messages) {
    sendEvent({ type: 'message', message: msg });
  }

  // Send current status after the message replay so the client can render
  // the full history before seeing the running/idle indicator.
  sendEvent({ type: 'status', status: thread.status });

  const unsubscribe = subscribeToThread(req.params.id, sendEvent);

  // Keep-alive ping every 25 seconds
  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

/**
 * POST /api/chat/threads/:id/messages
 * Send a user message. The agent response streams via SSE.
 * Body: SendMessageRequest
 */
router.post('/threads/:id/messages', requireThreadWrite, async (req: Request, res: Response) => {
  const body = req.body as Partial<SendMessageRequest>;
  let attachments: ChatAttachment[];
  try {
    attachments = readAttachments(body.attachments);
  } catch (err: any) {
    return res.status(err.status ?? 400).json({ error: err.message });
  }
  if (!body.text?.trim() && attachments.length === 0) {
    return res.status(400).json({ error: 'text or attachments are required' });
  }

  const thread = (req as any).thread as ChatThread;
  if (thread.status === 'running') return res.status(409).json({ error: 'Agent is already running' });

  // Fire-and-forget: response streams via SSE, this returns 202 immediately
  res.status(202).json({ ok: true });
  sendMessage(req.params.id, body.text ?? '', body.model, attachments).catch((err) => {
    console.error(`[chat] sendMessage error for thread ${req.params.id}:`, err.message);
  });
});

/**
 * POST /api/chat/threads/:id/cancel
 * Cancel the active run.
 */
router.post('/threads/:id/cancel', requireThreadWrite, async (req: Request, res: Response) => {
  try {
    await cancelRun(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to cancel' });
  }
});

/**
 * GET /api/chat/threads/:id/prd
 * Read the output PRD.md written by the agent (if available).
 */
router.get('/threads/:id/prd', requireThreadRead, (req: Request, res: Response) => {
  const content = readOutputPrd(req.params.id);
  if (content === null) return res.status(404).json({ error: 'PRD not yet generated' });
  res.type('text/markdown').send(content);
});

/**
 * GET /api/chat/threads/:id/backlog
 * Read the output *.backlog.json written by the agent (if available).
 */
router.get('/threads/:id/backlog', requireThreadRead, (req: Request, res: Response) => {
  const content = readOutputBacklog(req.params.id);
  if (content === null) return res.status(404).json({ error: 'Backlog not yet generated' });
  res.json(content);
});

/**
 * PUT /api/chat/threads/:id/prd
 * Overwrite the PRD with user-edited content.
 * Body: plain text (text/markdown or text/plain)
 */
router.put('/threads/:id/prd', requireThreadWrite, async (req: Request, res: Response) => {
  const content = typeof req.body === 'string' ? req.body : req.body?.content;
  if (typeof content !== 'string') return res.status(400).json({ error: 'body must be the markdown text' });
  try {
    const threadId = req.params.id;
    const prdRow = await db.query.prds.findFirst({ where: eq(prds.chatThreadId, threadId) });
    if (!prdRow) {
      return res.status(404).json({ error: 'No PRD found for this thread' });
    }
    await db.update(prds).set({ content, updatedAt: new Date().toISOString() }).where(eq(prds.id, prdRow.id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to write PRD' });
  }
});

/**
 * PATCH /api/chat/threads/:id/flag
 * Toggle the flagged state for a thread.
 * Body: { flagged: boolean }
 */
router.patch('/threads/:id/flag', requireThreadWrite, async (req: Request, res: Response) => {
  const { flagged } = req.body as { flagged?: boolean };
  if (typeof flagged !== 'boolean') {
    return res.status(400).json({ error: 'flagged (boolean) is required' });
  }
  try {
    const result = await toggleFlag(req.params.id, flagged);
    res.json(result);
  } catch (err: any) {
    console.error('[chat] toggleFlag error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to toggle flag' });
  }
});

/**
 * DELETE /api/chat/threads/:id
 * Close the thread, dispose the agent, and remove the workspace.
 */
router.delete('/threads/:id', requireThreadWrite, async (req: Request, res: Response) => {
  try {
    await closeThread(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to close thread' });
  }
});

export default router;
