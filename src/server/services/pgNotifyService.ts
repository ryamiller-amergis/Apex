/**
 * Postgres LISTEN/NOTIFY service for fan-out of agent run events across workers.
 *
 * Acquires a dedicated connection from the pool and LISTENs on a single channel.
 * All run events are multiplexed through one channel with a JSON payload containing
 * the threadId, so we avoid per-thread LISTEN/UNLISTEN churn.
 *
 * Usage:
 *   import { initPgNotify, notifyRunEvent, subscribeRunEvents, shutdownPgNotify } from './pgNotifyService';
 *   await initPgNotify();          // call once at server startup
 *   notifyRunEvent(threadId, ev);  // from the owner worker during streaming
 *   const unsub = subscribeRunEvents(threadId, cb); // from SSE route
 */
import pool from '../db';
import type { PoolClient } from 'pg';

const CHANNEL = 'agent_run_events';
const RECONNECT_DELAY_MS = 3_000;
const PAYLOAD_MAX_BYTES = 7_500; // PG NOTIFY payload limit is ~8000 bytes

export interface RunEvent {
  type: string;
  data?: any;
}

interface ChannelPayload {
  threadId: string;
  event: RunEvent;
}

type EventCallback = (event: RunEvent) => void;

const subscribers = new Map<string, Set<EventCallback>>();
let listenClient: PoolClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownRequested = false;

async function acquireListenConnection(): Promise<void> {
  if (shutdownRequested) return;

  try {
    listenClient = await pool.connect();

    listenClient.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const { threadId, event } = JSON.parse(msg.payload) as ChannelPayload;
        const subs = subscribers.get(threadId);
        if (!subs) return;
        for (const cb of subs) {
          try { cb(event); } catch { /* subscriber error */ }
        }
      } catch { /* malformed payload */ }
    });

    listenClient.on('error', (err) => {
      console.error('[pgNotify] LISTEN connection error:', err.message);
      releaseAndReconnect();
    });

    listenClient.on('end', () => {
      if (!shutdownRequested) {
        console.warn('[pgNotify] LISTEN connection ended unexpectedly, reconnecting…');
        releaseAndReconnect();
      }
    });

    await listenClient.query(`LISTEN ${CHANNEL}`);
    console.log('[pgNotify] LISTEN connection established');
  } catch (err) {
    console.error('[pgNotify] Failed to acquire LISTEN connection:', (err as Error).message);
    releaseAndReconnect();
  }
}

function releaseAndReconnect(): void {
  if (listenClient) {
    try { listenClient.release(true); } catch { /* already released */ }
    listenClient = null;
  }
  if (shutdownRequested) return;
  if (reconnectTimer) return; // already scheduled

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    acquireListenConnection().catch((err) => {
      console.error('[pgNotify] Reconnect attempt failed:', (err as Error).message);
    });
  }, RECONNECT_DELAY_MS);
}

/**
 * Initialize the LISTEN connection. Call once at server startup.
 */
export async function initPgNotify(): Promise<void> {
  shutdownRequested = false;
  await acquireListenConnection();
}

/**
 * Gracefully tear down the LISTEN connection. Call on server shutdown.
 */
export async function shutdownPgNotify(): Promise<void> {
  shutdownRequested = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (listenClient) {
    try {
      await listenClient.query(`UNLISTEN ${CHANNEL}`);
      listenClient.release();
    } catch { /* best effort */ }
    listenClient = null;
  }
}

/**
 * Publish a run event via NOTIFY. Safe to call from any worker.
 * Uses the shared pool (not the LISTEN client) for writes.
 */
export async function notifyRunEvent(threadId: string, event: RunEvent): Promise<void> {
  const payload = JSON.stringify({ threadId, event } satisfies ChannelPayload);
  if (Buffer.byteLength(payload) > PAYLOAD_MAX_BYTES) {
    // Truncate large token payloads — subscribers will get partial text but
    // won't miss the event entirely.
    const truncated: ChannelPayload = {
      threadId,
      event: { type: event.type, data: typeof event.data === 'string' ? event.data.slice(0, 2000) : event.data },
    };
    const truncPayload = JSON.stringify(truncated);
    await pool.query(`SELECT pg_notify($1, $2)`, [CHANNEL, truncPayload]);
    return;
  }
  await pool.query(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
}

/**
 * Subscribe to run events for a specific thread.
 * Returns an unsubscribe function.
 */
export function subscribeRunEvents(threadId: string, callback: EventCallback): () => void {
  let subs = subscribers.get(threadId);
  if (!subs) {
    subs = new Set();
    subscribers.set(threadId, subs);
  }
  subs.add(callback);

  return () => {
    subs!.delete(callback);
    if (subs!.size === 0) {
      subscribers.delete(threadId);
    }
  };
}
