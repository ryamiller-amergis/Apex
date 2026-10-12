/**
 * Dedicated Postgres NOTIFY channel for V2 outbox wake-ups.
 * Intentionally separate from agent_run_events (chat SSE).
 */
import type { Pool, PoolClient } from 'pg';
import pool from '../../db';

export const AI_RUN_OUTBOX_CHANNEL = 'ai_run_outbox';

export type AiRunOutboxNotifyPayload = Readonly<{
  outboxId?: string;
  runId?: string;
}>;

type OutboxWakeCallback = (payload: AiRunOutboxNotifyPayload) => void;

let listenClient: PoolClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;
const subscribers = new Set<OutboxWakeCallback>();

function parsePayload(raw: string | undefined): AiRunOutboxNotifyPayload {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      outboxId: typeof parsed.outboxId === 'string' ? parsed.outboxId : undefined,
      runId: typeof parsed.runId === 'string' ? parsed.runId : undefined,
    };
  } catch {
    return {};
  }
}

async function connectListen(db: Pool = pool): Promise<void> {
  if (shuttingDown || listenClient) return;
  try {
    listenClient = await db.connect();
    listenClient.on('notification', (msg) => {
      if (msg.channel !== AI_RUN_OUTBOX_CHANNEL) return;
      const payload = parsePayload(msg.payload);
      for (const cb of subscribers) {
        try {
          cb(payload);
        } catch (err) {
          console.error(
            '[aiOrchestrator/outboxNotify] subscriber error:',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    });
    listenClient.on('error', (err) => {
      console.error('[aiOrchestrator/outboxNotify] LISTEN error:', err.message);
      void reconnect(db);
    });
    listenClient.on('end', () => {
      if (!shuttingDown) void reconnect(db);
    });
    await listenClient.query(`LISTEN ${AI_RUN_OUTBOX_CHANNEL}`);
  } catch (err) {
    console.error(
      '[aiOrchestrator/outboxNotify] Failed to LISTEN:',
      err instanceof Error ? err.message : String(err),
    );
    listenClient = null;
    scheduleReconnect(db);
  }
}

function scheduleReconnect(db: Pool): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void reconnect(db);
  }, 3_000);
  reconnectTimer.unref?.();
}

async function reconnect(db: Pool): Promise<void> {
  if (listenClient) {
    try {
      listenClient.release(true);
    } catch {
      /* already released */
    }
    listenClient = null;
  }
  await connectListen(db);
}

/**
 * Emit a wake signal. Prefer calling inside the same SQL transaction as the
 * outbox INSERT via notifyAiRunOutboxSql / executor.execute.
 */
export async function notifyAiRunOutbox(
  payload: AiRunOutboxNotifyPayload = {},
  db: Pool = pool,
): Promise<void> {
  const body = JSON.stringify({
    outboxId: payload.outboxId ?? null,
    runId: payload.runId ?? null,
  });
  await db.query(`SELECT pg_notify($1, $2)`, [AI_RUN_OUTBOX_CHANNEL, body]);
}

/** Raw SQL fragment helper for transactional notify via Drizzle sql templates. */
export function buildOutboxNotifyPayload(
  payload: AiRunOutboxNotifyPayload,
): string {
  return JSON.stringify({
    outboxId: payload.outboxId ?? null,
    runId: payload.runId ?? null,
  });
}

export async function initAiRunOutboxNotify(db: Pool = pool): Promise<void> {
  shuttingDown = false;
  await connectListen(db);
}

export async function shutdownAiRunOutboxNotify(): Promise<void> {
  shuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (listenClient) {
    try {
      await listenClient.query(`UNLISTEN ${AI_RUN_OUTBOX_CHANNEL}`);
      listenClient.release();
    } catch {
      try {
        listenClient.release(true);
      } catch {
        /* ignore */
      }
    }
    listenClient = null;
  }
}

export function subscribeAiRunOutbox(callback: OutboxWakeCallback): () => void {
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

/** Test helper — deliver a synthetic wake without Postgres. */
export function __testDeliverOutboxWake(payload: AiRunOutboxNotifyPayload): void {
  for (const cb of subscribers) cb(payload);
}

export function __testResetOutboxNotifyState(): void {
  subscribers.clear();
  shuttingDown = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  listenClient = null;
}
