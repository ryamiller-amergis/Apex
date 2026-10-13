/**
 * LISTEN/NOTIFY hints for Playbook run projection refreshes on the canvas live view.
 * Payload is only `{ runId }`; clients refetch authoritative state from the projection.
 */
import pool from '../db';
import type { PoolClient } from 'pg';

const CHANNEL = 'playbook_run_events';
const RECONNECT_DELAY_MS = 3_000;

type RunCallback = (payload: { runId: string }) => void;

const subscribersByRun = new Map<string, Set<RunCallback>>();
let listenClient: PoolClient | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownRequested = false;

function dispatch(runId: string): void {
  const payload = { runId };
  const set = subscribersByRun.get(runId);
  if (set) {
    for (const callback of set) callback(payload);
  }
}

async function startListening(): Promise<void> {
  if (listenClient || shutdownRequested) return;
  const client = await pool.connect();
  listenClient = client;
  client.on('error', () => {
    listenClient = null;
    if (!shutdownRequested && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void startListening();
      }, RECONNECT_DELAY_MS);
    }
  });
  client.on('notification', (message) => {
    if (message.channel !== CHANNEL || !message.payload) return;
    try {
      const parsed = JSON.parse(message.payload) as { runId?: string };
      if (parsed.runId) dispatch(parsed.runId);
    } catch {
      // ignore malformed payloads
    }
  });
  await client.query(`LISTEN ${CHANNEL}`);
}

export async function ensurePlaybookRunNotifyListener(): Promise<void> {
  await startListening();
}

export async function notifyPlaybookRunChanged(runId: string): Promise<void> {
  dispatch(runId);
  await pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify({ runId })]);
}

export function subscribePlaybookRunEvents(
  runId: string,
  callback: RunCallback
): () => void {
  void ensurePlaybookRunNotifyListener();
  const set = subscribersByRun.get(runId) ?? new Set();
  set.add(callback);
  subscribersByRun.set(runId, set);
  return () => {
    const current = subscribersByRun.get(runId);
    if (!current) return;
    current.delete(callback);
    if (current.size === 0) subscribersByRun.delete(runId);
  };
}

export async function shutdownPlaybookRunNotify(): Promise<void> {
  shutdownRequested = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (listenClient) {
    await listenClient.query(`UNLISTEN ${CHANNEL}`);
    listenClient.release();
    listenClient = null;
  }
}
