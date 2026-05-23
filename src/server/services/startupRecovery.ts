import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { prds, designDocs } from '../db/schema';
import { hydrateThread } from './chatAgentService';
import { startPrdWatcher } from './prdService';
import { startDesignDocWatcher, startValidationWatcher } from './designDocService';

const RECOVERY_INTERVAL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 10_000;

let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Query the database for PRDs and design docs stuck in transient statuses
 * (generating, validating) and restart their watchers.  This handles:
 *   - Server restarts / deploys that kill in-memory watchers
 *   - Rolling deployments where the old instance dies after the new one starts
 *
 * Safe to call repeatedly — watchers are idempotent (stop-then-start).
 */
export async function recoverInFlightWork(): Promise<void> {
  let recovered = 0;

  const generatingPrds = await db.query.prds.findMany({
    where: eq(prds.status, 'generating'),
    columns: { id: true, chatThreadId: true },
  });
  for (const prd of generatingPrds) {
    if (!prd.chatThreadId) continue;
    const ok = await hydrateThread(prd.chatThreadId);
    if (ok) {
      startPrdWatcher(prd.id, prd.chatThreadId);
      recovered++;
      console.log(`[recovery] Restarted PRD watcher (prdId=${prd.id})`);
    } else {
      console.warn(`[recovery] Could not hydrate thread for PRD (prdId=${prd.id}, threadId=${prd.chatThreadId})`);
    }
  }

  const generatingDocs = await db.query.designDocs.findMany({
    where: eq(designDocs.status, 'generating'),
    columns: { id: true, chatThreadId: true },
  });
  for (const doc of generatingDocs) {
    if (!doc.chatThreadId) continue;
    const ok = await hydrateThread(doc.chatThreadId);
    if (ok) {
      startDesignDocWatcher(doc.id, doc.chatThreadId);
      recovered++;
      console.log(`[recovery] Restarted design doc watcher (designDocId=${doc.id})`);
    } else {
      console.warn(`[recovery] Could not hydrate thread for design doc (designDocId=${doc.id}, threadId=${doc.chatThreadId})`);
    }
  }

  const validatingDocs = await db.query.designDocs.findMany({
    where: eq(designDocs.status, 'validating'),
    columns: { id: true, validationThreadId: true },
  });
  for (const doc of validatingDocs) {
    if (!doc.validationThreadId) continue;
    const ok = await hydrateThread(doc.validationThreadId);
    if (ok) {
      startValidationWatcher(doc.id, doc.validationThreadId);
      recovered++;
      console.log(`[recovery] Restarted validation watcher (designDocId=${doc.id})`);
    } else {
      console.warn(`[recovery] Could not hydrate thread for validation (designDocId=${doc.id}, threadId=${doc.validationThreadId})`);
    }
  }

  if (recovered > 0) {
    console.log(`[recovery] Recovered ${recovered} in-flight watcher(s)`);
  }
}

/**
 * Run initial recovery, then schedule periodic checks to catch work that
 * was orphaned by a previous instance dying after this one started.
 */
export function startRecoveryLoop(): void {
  recoverInFlightWork().catch((err) => {
    console.error('[recovery] Initial recovery failed:', err);
  });

  recoveryTimer = setInterval(() => {
    recoverInFlightWork().catch((err) => {
      console.error('[recovery] Periodic recovery failed:', err);
    });
  }, RECOVERY_INTERVAL_MS);
}

/**
 * Register SIGTERM / SIGINT handlers for graceful shutdown.
 * Stops accepting new connections and waits for in-flight requests
 * before exiting so rolling deployments don't drop requests.
 */
export function registerGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received — draining connections (${SHUTDOWN_GRACE_MS / 1000}s grace)…`);

    if (recoveryTimer) {
      clearInterval(recoveryTimer);
      recoveryTimer = null;
    }

    server.close(() => {
      console.log('[shutdown] All connections drained — exiting');
      process.exit(0);
    });

    setTimeout(() => {
      console.warn('[shutdown] Grace period expired — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
