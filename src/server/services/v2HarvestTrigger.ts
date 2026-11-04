/**
 * Applies finished V2 document and prototype runs as soon as the orchestrator
 * announces a run ending, instead of waiting for the next recovery sweep.
 *
 * The recovery sweep and this trigger share one lease, so only one process
 * applies results at a time; a harvest claim alone does not stop a second
 * process from applying the same attempt while the first is still running.
 */
import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import { harvestFinishedV2Prototypes } from './designPrototypeV2Harvest';
import { harvestFinishedV2Documents } from './documentV2Harvest';
import { subscribeAllRunEvents } from './pgNotifyService';
import {
  NonblockingRepoCacheLeaseUnavailableError,
  withRepoCacheLease,
} from './repoCacheLeaseService';

export const V2_HARVEST_LEASE_KEY = 'ai-run-v2-harvest';
const V2_HARVEST_LEASE_MS = 60_000;
const V2_HARVEST_HEARTBEAT_MS = 15_000;
/** Another process holds the lease and may have listed attempts before this run ended. */
const BUSY_RETRY_MS = 3_000;
const MAX_BUSY_RETRIES = 5;

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export type V2HarvestTriggerDependencies = Readonly<{
  harvestDocuments?: () => Promise<number>;
  harvestPrototypes?: () => Promise<number>;
  withLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  subscribe?: (callback: (event: AgentRunEventEnvelope) => void) => () => void;
  setTimer?: (callback: () => void, ms: number) => void;
}>;

/** Runs `operation` while holding the shared V2 harvest lease. */
export function withV2HarvestLease<T>(
  operation: () => Promise<T>,
  waitMs = 0,
): Promise<T> {
  return withRepoCacheLease(V2_HARVEST_LEASE_KEY, () => operation(), {
    leaseMs: V2_HARVEST_LEASE_MS,
    heartbeatMs: V2_HARVEST_HEARTBEAT_MS,
    waitMs,
  });
}

export function isRunEndedEvent(event: AgentRunEventEnvelope): boolean {
  return event.type === 'done' && TERMINAL_STATUSES.has(event.status);
}

export function createV2HarvestTrigger(dependencies: V2HarvestTriggerDependencies = {}) {
  const harvestDocuments = dependencies.harvestDocuments ?? (() => harvestFinishedV2Documents());
  const harvestPrototypes = dependencies.harvestPrototypes ?? (() => harvestFinishedV2Prototypes());
  const withLease = dependencies.withLease ?? ((operation) => withV2HarvestLease(operation));
  const subscribe = dependencies.subscribe ?? subscribeAllRunEvents;
  const setTimer = dependencies.setTimer ?? ((callback, ms) => {
    setTimeout(callback, ms).unref?.();
  });

  let running = false;
  let again = false;
  let busyRetries = 0;
  let unsubscribe: (() => void) | null = null;

  async function harvestOnce(): Promise<'done' | 'busy'> {
    try {
      await withLease(async () => {
        await harvestDocuments();
        await harvestPrototypes();
      });
      return 'done';
    } catch (error) {
      if (error instanceof NonblockingRepoCacheLeaseUnavailableError) return 'busy';
      console.error('[v2-harvest] Event-triggered harvest failed:', (error as Error).message);
      return 'done';
    }
  }

  async function drain(): Promise<void> {
    try {
      do {
        again = false;
        const outcome = await harvestOnce();
        if (outcome === 'busy') {
          if (busyRetries < MAX_BUSY_RETRIES) {
            busyRetries += 1;
            setTimer(request, BUSY_RETRY_MS);
          }
          return;
        }
        busyRetries = 0;
      } while (again);
    } finally {
      running = false;
    }
  }

  function request(): void {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void drain();
  }

  return {
    request,
    start(): void {
      if (unsubscribe) return;
      unsubscribe = subscribe((event) => {
        if (isRunEndedEvent(event)) request();
      });
    },
    stop(): void {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

const defaultTrigger = createV2HarvestTrigger();

export function startV2HarvestTrigger(): void {
  defaultTrigger.start();
}

export function stopV2HarvestTrigger(): void {
  defaultTrigger.stop();
}
