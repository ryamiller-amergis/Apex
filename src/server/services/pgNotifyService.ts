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
 *   notifyRunEvent(envelope, { persist: true }); // from the run owner
 *   const unsub = subscribeRunEvents(threadId, cb); // from SSE route
 */
import pool from '../db';
import type { PoolClient } from 'pg';
import os from 'os';
import { randomUUID } from 'crypto';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';

const CHANNEL = 'agent_run_events';
const RECONNECT_DELAY_MS = 3_000;
const PAYLOAD_MAX_BYTES = 7_500; // PG NOTIFY payload limit is ~8000 bytes
const MAX_DELIVERED_EVENT_IDS = 2_000;

export const RUN_EVENT_SOURCE_INSTANCE = `${os.hostname()}:${process.pid}:${randomUUID()}`;

interface ChannelPayload {
  threadId: string;
  eventId: string;
  event?: AgentRunEventEnvelope;
}

type EventCallback = (event: AgentRunEventEnvelope) => void;

const subscribers = new Map<string, Set<EventCallback>>();
const deliveredEventIds = new Set<string>();
const deliveredEventIdOrder: string[] = [];
const runEventSequences = new Map<string, number>();
let listenClient: PoolClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownRequested = false;

export function nextRunEventSequence(
  runId: string,
  sourceInstance = RUN_EVENT_SOURCE_INSTANCE,
): number {
  const key = `${sourceInstance}\0${runId}`;
  const sequence = (runEventSequences.get(key) ?? 0) + 1;
  runEventSequences.set(key, sequence);
  return sequence;
}

export function clearRunEventSequence(
  runId: string,
  sourceInstance = RUN_EVENT_SOURCE_INSTANCE,
): void {
  runEventSequences.delete(`${sourceInstance}\0${runId}`);
}

async function acquireListenConnection(): Promise<void> {
  if (shutdownRequested) return;

  try {
    listenClient = await pool.connect();

    listenClient.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      void handleNotificationPayload(msg.payload);
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

function rememberDeliveredEventId(eventId: string): boolean {
  if (deliveredEventIds.has(eventId)) return false;
  deliveredEventIds.add(eventId);
  deliveredEventIdOrder.push(eventId);
  if (deliveredEventIdOrder.length > MAX_DELIVERED_EVENT_IDS) {
    const oldest = deliveredEventIdOrder.shift();
    if (oldest) deliveredEventIds.delete(oldest);
  }
  return true;
}

function rowToEnvelope(row: Record<string, any>): AgentRunEventEnvelope {
  return {
    eventId: row.event_id,
    threadId: row.thread_id,
    runId: row.run_id,
    sourceInstance: row.source_instance,
    sequence: Number(row.sequence),
    timestamp: typeof row.event_timestamp === 'string'
      ? row.event_timestamp
      : new Date(row.event_timestamp).toISOString(),
    type: row.event_type,
    phase: row.phase,
    status: row.status,
    detail: row.detail ?? undefined,
    event: row.event,
  };
}

async function loadRunEvent(eventId: string): Promise<AgentRunEventEnvelope | null> {
  const result = await pool.query(
    `SELECT event_id, thread_id, run_id, source_instance, sequence,
            event_timestamp, event_type, phase, status, detail, event
       FROM agent_run_events
      WHERE event_id = $1`,
    [eventId],
  );
  return result.rows[0] ? rowToEnvelope(result.rows[0]) : null;
}

async function handleNotificationPayload(payload: string): Promise<void> {
  try {
    const parsed = JSON.parse(payload) as ChannelPayload;
    const event = parsed.event ?? await loadRunEvent(parsed.eventId);
    if (event) dispatchRunEventForTest(event);
  } catch {
    // Ignore malformed or already-pruned events.
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
 * Optionally persist an immutable run event, then fan it out via NOTIFY.
 * Safe to call from any worker; uses the shared pool for writes.
 */
export async function notifyRunEvent(
  event: AgentRunEventEnvelope,
  options: { persist: boolean },
): Promise<void> {
  if (options.persist) {
    await pool.query(
      `INSERT INTO agent_run_events (
         event_id, thread_id, run_id, source_instance, sequence,
         event_timestamp, event_type, phase, status, detail, event
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.eventId,
        event.threadId,
        event.runId,
        event.sourceInstance,
        event.sequence,
        event.timestamp,
        event.type,
        event.phase,
        event.status,
        event.detail ?? null,
        JSON.stringify(event.event),
      ],
    );
  }

  const fullPayload = {
    threadId: event.threadId,
    eventId: event.eventId,
    event,
  } satisfies ChannelPayload;
  let payload = JSON.stringify(fullPayload);
  if (Buffer.byteLength(payload) > PAYLOAD_MAX_BYTES) {
    if (!options.persist) {
      throw new Error(`Run event ${event.eventId} exceeds PostgreSQL NOTIFY payload limit`);
    }
    payload = JSON.stringify({
      threadId: event.threadId,
      eventId: event.eventId,
    } satisfies ChannelPayload);
  }
  await pool.query(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
}

export async function replayRunEvents(
  threadId: string,
  afterEventId?: string,
  limit = 500,
): Promise<AgentRunEventEnvelope[]> {
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const result = await pool.query(
    `WITH cursor AS (
       SELECT ordinal
         FROM agent_run_events
        WHERE event_id = $2::uuid
     )
     SELECT event_id, thread_id, run_id, source_instance, sequence,
            event_timestamp, event_type, phase, status, detail, event
       FROM agent_run_events
      WHERE thread_id = $1
        AND ordinal > COALESCE((SELECT cursor.ordinal FROM cursor), 0)
      ORDER BY ordinal ASC
      LIMIT $3`,
    [threadId, afterEventId ?? null, boundedLimit],
  );
  return result.rows.map(rowToEnvelope);
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

/** Shared dispatch path, exported to keep LISTEN deduplication unit-testable. */
export function dispatchRunEventForTest(event: AgentRunEventEnvelope): void {
  if (!rememberDeliveredEventId(event.eventId)) return;
  const subs = subscribers.get(event.threadId);
  if (!subs) return;
  for (const callback of subs) {
    try { callback(event); } catch { /* subscriber error */ }
  }
}
