import { Router, Request, Response, NextFunction } from 'express';
import {
  createThread,
  listThreadSummaries,
  searchThreadSummaries,
  sendMessage,
  subscribeToThread,
  cancelRun,
  permanentlyDeleteThread,
  readOutputPrd,
  readOutputBacklog,
  isPrdReady,
  getThread,
} from '../services/chatAgentService';
import { db } from '../db/drizzle';
import { eq, desc } from 'drizzle-orm';
import { agentRuns, chatThreads, prds } from '../db/schema';
import { toggleFlag } from '../services/chatThreadRepository';
import { resolveThreadAccess, canWriteThread } from '../services/threadAccessService';
import { getUserId } from '../utils/requestUser';
import type {
  AgentRunEventEnvelope,
  AgentRunStatusResponse,
  AgentRunPhase,
  ChatAttachment,
  ChatThread,
  SseEvent,
  StartChatRequest,
  SendMessageRequest,
} from '../../shared/types/chat';
import type { ThreadAccess } from '../services/threadAccessService';
import { requirePermission } from '../middleware/rbac';
import { writeSseEvent, startSseHeartbeat } from '../utils/sseResponse';
import {
  replayRunEvents,
  RUN_EVENT_SOURCE_INSTANCE,
  subscribeRunEvents,
} from '../services/pgNotifyService';
import {
  assessAgentRunHealth,
  resolveAgentRunHealthConfig,
  type AgentRunHealthConfig,
  type AgentRunHealthSnapshot,
} from '../services/agentRunReaperService';
import { getMyWorkSessionContext, logMyWorkSession } from '../services/myWorkSessionLogger';

const router = Router();

router.use(requirePermission('chat:view'));
const MAX_CHAT_ATTACHMENTS = 5;
const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_STREAM_EVENT_IDS = 2_000;

export function eventForRunEnvelope(envelope: AgentRunEventEnvelope): SseEvent {
  const event: SseEvent = envelope.event.type === 'cancel'
    ? { type: 'done', runId: envelope.runId }
    : envelope.event;
  return {
    ...event,
    runId: envelope.runId,
    eventTimestamp: envelope.timestamp,
    semanticPhase: envelope.phase,
    semanticStatus: envelope.status,
    ...(envelope.detail ? { semanticDetail: envelope.detail } : {}),
  };
}

export function formatRunEventSse(envelope: AgentRunEventEnvelope): string {
  return `id: ${envelope.eventId}\ndata: ${JSON.stringify(eventForRunEnvelope(envelope))}\n\n`;
}

export function shouldForwardPgRunEvent(
  envelope: AgentRunEventEnvelope,
  localInstance = RUN_EVENT_SOURCE_INSTANCE,
): boolean {
  return envelope.sourceInstance !== localInstance;
}

export function shouldAssignRunEventSseId(envelope: AgentRunEventEnvelope): boolean {
  return envelope.event.type === 'phase'
    || envelope.event.type === 'health'
    || envelope.event.type === 'tool_call'
    || envelope.event.type === 'tool_status'
    || envelope.event.type === 'status'
    || envelope.event.type === 'retrying'
    || envelope.event.type === 'error'
    || envelope.event.type === 'done'
    || envelope.event.type === 'cancel';
}

interface RunStatusRow extends AgentRunHealthSnapshot {
  id: string;
  lastError: string | null;
  progressLabel: string | null;
  progressPhase: AgentRunPhase | null;
}

export function buildRunStatusResponse(
  row: RunStatusRow | null,
  nowMs = Date.now(),
  config: AgentRunHealthConfig = resolveAgentRunHealthConfig(),
): AgentRunStatusResponse {
  if (!row) {
    return {
      runId: null,
      status: 'idle',
      health: 'healthy',
      lastError: null,
      progressAt: null,
      progressLabel: null,
      progressPhase: null,
      startedAt: null,
      elapsedMs: 0,
    };
  }

  const terminalHealth = row.lastError?.startsWith('Worker lost')
    ? 'worker_lost'
    : row.lastError?.startsWith('Run exceeded configured hard limit')
      ? 'hard_timeout'
      : row.lastError?.startsWith('Never claimed')
        ? 'never_claimed'
        : null;
  return {
    runId: row.id,
    status: row.status,
    health: terminalHealth ?? assessAgentRunHealth(row, nowMs, config),
    lastError: row.lastError,
    progressAt: row.progressAt ?? null,
    progressLabel: row.progressLabel,
    progressPhase: row.progressPhase,
    startedAt: row.startedAt,
    elapsedMs: row.startedAt
      ? Math.max(0, nowMs - new Date(row.startedAt).getTime())
      : 0,
  };
}

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
 * Query params: limit, offset, project, flaggedOnly, and optional search term q.
 */
router.get('/threads', async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const project = typeof req.query.project === 'string' ? req.query.project : undefined;
  const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const flaggedOnly = req.query.flaggedOnly === 'true';
  try {
    const userId = getUserId(req);
    const summaries = term.length >= 2
      ? await searchThreadSummaries(userId, {
          term,
          limit,
          offset,
          project,
          flaggedOnly,
        })
      : await listThreadSummaries(userId, { limit, offset, project });
    res.json(summaries);
  } catch (err: any) {
    console.error('[chat] thread list error:', err.message);
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
router.get('/threads/:id/stream', requireThreadRead, async (req: Request, res: Response) => {
  const thread = (req as any).thread as ChatThread;
  const streamStartedAt = Date.now();
  const myWorkContext = thread.kickoff?.mode === 'development'
    ? await getMyWorkSessionContext(req.params.id).catch(() => null)
    : null;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering
  res.flushHeaders();

  let stopHeartbeat = () => {};
  let unsubscribe = () => {};
  let unsubNotify = () => {};
  const sentEventIds = new Set<string>();
  const sentEventIdOrder: string[] = [];
  let replaying = true;
  const pendingLiveEvents: AgentRunEventEnvelope[] = [];

  const rememberEventId = (eventId: string): boolean => {
    if (sentEventIds.has(eventId)) return false;
    sentEventIds.add(eventId);
    sentEventIdOrder.push(eventId);
    if (sentEventIdOrder.length > MAX_STREAM_EVENT_IDS) {
      const oldest = sentEventIdOrder.shift();
      if (oldest) sentEventIds.delete(oldest);
    }
    return true;
  };

  const closeStream = () => {
    stopHeartbeat();
    unsubscribe();
    unsubNotify();
  };

  const sendEvent = (event: object, eventId?: string) => {
    if (eventId && !rememberEventId(eventId)) return;
    const written = eventId
      ? (!res.writableEnded && !res.destroyed && (() => {
          try {
            res.write(`id: ${eventId}\ndata: ${JSON.stringify(event)}\n\n`);
            return true;
          } catch {
            return false;
          }
        })())
      : writeSseEvent(res, event);
    if (!written) {
      closeStream();
    }
  };

  const sendEnvelope = (envelope: AgentRunEventEnvelope) => {
    if (envelope.event.type === 'cancel') {
      sendEvent({ type: 'status', status: 'idle' });
      sendEvent({ type: 'done', runId: envelope.runId }, envelope.eventId);
      return;
    }
    sendEvent(
      eventForRunEnvelope(envelope),
      shouldAssignRunEventSseId(envelope) ? envelope.eventId : undefined,
    );
  };

  const queueOrSendEnvelope = (envelope: AgentRunEventEnvelope) => {
    if (replaying) {
      pendingLiveEvents.push(envelope);
    } else {
      sendEnvelope(envelope);
    }
  };

  const sendLocalEvent = (event: SseEvent, envelope?: AgentRunEventEnvelope) => {
    if (envelope) {
      queueOrSendEnvelope(envelope);
    } else if (!writeSseEvent(res, event)) {
      closeStream();
    }
  };

  // Hydrate the thread into memory BEFORE subscribing. subscribeToThread only
  // attaches to the in-memory threads Map; if the thread was evicted (idle
  // timeout) or lost (server restart), subscribing without hydration is a
  // silent no-op and the client would receive no agent output when it later
  // sends a message (e.g. resuming an interview the next day). Hydration also
  // normalizes a stale 'running' status back to 'idle'.
  const hydrated = await getThread(req.params.id).catch(() => null);

  // Replay all existing messages so late-joining subscribers (including
  // the very first connect right after thread creation) never miss events.
  // Prefer the hydrated in-memory messages (may include writes not yet
  // flushed to Postgres) over the stale middleware snapshot.
  const replayMessages = hydrated?.messages ?? thread.messages;
  for (const msg of replayMessages) {
    sendEvent({ type: 'message', message: msg });
  }

  // Send current status after the message replay so the client can render
  // the full history before seeing the running/idle indicator. Prefer the
  // hydrated status since it reflects the normalized in-memory state.
  sendEvent({ type: 'status', status: hydrated?.status ?? thread.status });

  unsubscribe = subscribeToThread(req.params.id, sendLocalEvent);

  // Cross-worker: also subscribe via Postgres LISTEN/NOTIFY so tokens from
  // another worker's run are forwarded to this SSE connection.
  unsubNotify = subscribeRunEvents(req.params.id, (envelope) => {
    // The owner already delivered this envelope through its in-memory
    // subscriber. PostgreSQL echoes are only for other workers.
    if (!shouldForwardPgRunEvent(envelope)) return;
    queueOrSendEnvelope(envelope);
  });

  const lastEventId = req.get('Last-Event-ID')?.trim() || undefined;
  const replayEvents = await replayRunEvents(req.params.id, lastEventId).catch((err) => {
    console.error(`[chat] run-event replay failed for thread ${req.params.id}:`, (err as Error).message);
    return [];
  });
  for (const envelope of replayEvents) sendEnvelope(envelope);
  replaying = false;
  pendingLiveEvents
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence)
    .forEach(sendEnvelope);

  stopHeartbeat = startSseHeartbeat(res);
  if (myWorkContext) {
    logMyWorkSession('stream.connected', {
      ...myWorkContext,
      threadStatus: hydrated?.status ?? thread.status,
      replayedMessageCount: replayMessages.length,
      replayedEventCount: replayEvents.length,
      resumedFromEvent: Boolean(lastEventId),
    });
  }

  req.on('close', () => {
    closeStream();
    if (myWorkContext) {
      logMyWorkSession('stream.disconnected', {
        ...myWorkContext,
        durationMs: Date.now() - streamStartedAt,
        threadStatus: hydrated?.status ?? thread.status,
      });
    }
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
 * GET /api/chat/threads/:id/run-status
 * Lightweight polling endpoint — returns only { status, lastError } from Postgres.
 * Used by the client as a fallback when SSE is disconnected while status==='running'.
 */
router.get('/threads/:id/run-status', requireThreadRead, async (req: Request, res: Response) => {
  try {
    const [row] = await db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        lastError: agentRuns.lastError,
        progressAt: agentRuns.progressAt,
        progressLabel: agentRuns.progressLabel,
        progressPhase: agentRuns.progressPhase,
        createdAt: agentRuns.createdAt,
        startedAt: agentRuns.startedAt,
        heartbeatAt: agentRuns.heartbeatAt,
        timeoutAt: agentRuns.timeoutAt,
      })
      .from(agentRuns)
      .where(eq(agentRuns.threadId, req.params.id))
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);

    res.json(buildRunStatusResponse(row ?? null));
  } catch (err: any) {
    console.error('[chat] run-status error:', err.message);
    res.status(500).json({ error: err.message ?? 'Failed to fetch run status' });
  }
});

/**
 * DELETE /api/chat/threads/:id
 * Permanently delete the thread from memory, workspace, and database.
 */
router.delete('/threads/:id', requireThreadWrite, async (req: Request, res: Response) => {
  try {
    await permanentlyDeleteThread(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to delete thread' });
  }
});

export default router;
