import type { Server } from 'http';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { prds, designDocs, testCases, devSessions } from '../db/schema';
import { hydrateThread, isThreadIdle, sendMessage } from './chatAgentService';
import { startPrdWatcher, isPrdValidationWatcherActive, rehydratePrdValidationWatcher } from './prdService';
import {
  startSingleFeatureDocWatcher,
  startValidationWatcher,
  isValidationWatcherActive,
} from './designDocService';
import { startTestCaseWatcher, isTestCaseWatcherActive } from './testCaseService';
import { failStalePrototypes } from './designPrototypeService';
import {
  findRunningInterviewThreads,
  clearStaleRun,
} from './chatThreadRepository';
import { expireOldSessions } from './pdfAssemblyService';
import { recoverAnalyzingFeatureRequests } from './featureRequestAnalysisService';

const RECOVERY_INTERVAL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60_000;
/**
 * How long a design prototype may sit in `generating`/`regenerating` before the
 * recovery loop treats it as orphaned. Set well above the maximum configurable Bedrock timeout
 * (20 min) so a slow-but-live generation is never reset out from under itself.
 */
const STALE_PROTOTYPE_MS = 25 * 60_000;

let recoveryTimer: ReturnType<typeof setInterval> | null = null;

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface StaleSetupRecoveryOptions {
  now?: () => number;
  setupTimeoutMs?: number;
}

/**
 * Fail setup rows whose owner disappeared before creating a chat thread.
 * `updatedAt` is refreshed at setup phase boundaries, so this lease is separate
 * from agent-run heartbeat and meaningful-progress tracking.
 */
export async function recoverStaleDevSessionSetups(
  options: StaleSetupRecoveryOptions = {},
): Promise<number> {
  const nowMs = options.now?.() ?? Date.now();
  const setupTimeoutMs = options.setupTimeoutMs
    ?? positiveDuration(process.env.DEV_SESSION_SETUP_TIMEOUT_MS, DEFAULT_SETUP_TIMEOUT_MS);
  const settingUp = await db.query.devSessions.findMany({
    where: eq(devSessions.status, 'setting_up'),
    columns: { id: true, status: true, updatedAt: true },
  });
  let failed = 0;

  for (const session of settingUp) {
    const updatedAtMs = Date.parse(session.updatedAt);
    if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < setupTimeoutMs) continue;

    const updatedAt = new Date(nowMs).toISOString();
    const setupError = `Setup timed out after ${Math.round(setupTimeoutMs / 60_000)} minutes. The setup worker may have restarted or stopped responding; start a new development session to retry.`;
    await db
      .update(devSessions)
      .set({
        status: 'failed',
        setupError,
        setupPhase: 'dependencies_failed',
        setupDetail: setupError,
        setupProgressAt: updatedAt,
        updatedAt,
      })
      .where(and(eq(devSessions.id, session.id), eq(devSessions.status, 'setting_up')));
    failed++;
    console.warn(`[recovery] Failed abandoned dev session setup (sessionId=${session.id})`);
  }

  return failed;
}

/**
 * Query the database for PRDs and design docs stuck in transient statuses
 * (generating, validating) and restart their watchers.  This handles:
 *   - Server restarts / deploys that kill in-memory watchers
 *   - Rolling deployments where the old instance dies after the new one starts
 *
 * Safe to call repeatedly — watchers are idempotent (stop-then-start).
 *
 * For validation threads, if the agent was killed mid-run (status idle after
 * hydration), the agent is re-kicked via sendMessage so the run resumes.
 * Generation agents are NOT re-kicked here — dead generation agents must be
 * retried manually via POST /design-docs/:id/retry-generate to avoid ENOENT
 * crashes from missing local workspaces.
 */
export async function recoverInFlightWork(): Promise<void> {
  let recovered = 0;

  try {
    recovered += await recoverStaleDevSessionSetups();
  } catch (err) {
    console.error('[recovery] Failed to recover abandoned dev session setups:', err);
  }

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
      console.warn(
        `[recovery] Could not hydrate thread for PRD (prdId=${prd.id}, threadId=${prd.chatThreadId})`
      );
    }
  }

  const generatingDocs = await db.query.designDocs.findMany({
    where: eq(designDocs.status, 'generating'),
    columns: {
      id: true,
      chatThreadId: true,
      prdId: true,
      project: true,
      designPrototypeId: true,
    },
  });
  for (const doc of generatingDocs) {
    if (!doc.chatThreadId) continue;
    const ok = await hydrateThread(doc.chatThreadId);
    if (ok) {
      startSingleFeatureDocWatcher(doc.id, doc.chatThreadId, doc.prdId, doc.project);
      recovered++;
      console.log(
        `[recovery] Restarted design doc watcher (designDocId=${doc.id})`
      );
    } else {
      console.warn(
        `[recovery] Could not hydrate thread for design doc (designDocId=${doc.id}, threadId=${doc.chatThreadId})`
      );
    }
  }

  const validatingDocs = await db.query.designDocs.findMany({
    where: eq(designDocs.status, 'validating'),
    columns: { id: true, validationThreadId: true },
  });
  for (const doc of validatingDocs) {
    if (!doc.validationThreadId) {
      // No thread at all — stuck without any way to resume
      await db.update(designDocs)
        .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
        .where(and(eq(designDocs.id, doc.id), eq(designDocs.status, 'validating')));
      recovered++;
      console.warn(
        `[recovery] Design doc validating with no thread — reset to pending_review (designDocId=${doc.id})`
      );
      continue;
    }
    // Skip docs that already have an active watcher — avoids clobbering a
    // watcher that was just started by autoStartValidation or acceptFixValidation.
    if (isValidationWatcherActive(doc.id)) continue;
    const ok = await hydrateThread(doc.validationThreadId);
    if (ok) {
      startValidationWatcher(doc.id, doc.validationThreadId);
      recovered++;
      console.log(
        `[recovery] Restarted validation watcher (designDocId=${doc.id})`
      );

      // If the agent was killed mid-run (thread is idle after hydration), re-kick
      // it so the validation run actually resumes rather than the watcher polling forever.
      if (isThreadIdle(doc.validationThreadId)) {
        sendMessage(doc.validationThreadId, 'Begin.').catch((err: Error) => {
          console.error(
            `[recovery] Failed to re-kick validation agent (designDocId=${doc.id}, threadId=${doc.validationThreadId}):`,
            err.message
          );
        });
        console.log(
          `[recovery] Re-kicked dead validation agent (designDocId=${doc.id})`
        );
      }
    } else {
      // Thread is unrecoverable — reset the doc so it's not stuck forever
      await db.update(designDocs)
        .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
        .where(and(eq(designDocs.id, doc.id), eq(designDocs.status, 'validating')));
      recovered++;
      console.warn(
        `[recovery] Could not hydrate validation thread — reset to pending_review (designDocId=${doc.id}, threadId=${doc.validationThreadId})`
      );
    }
  }

  const generatingTestCases = await db.query.testCases.findMany({
    where: eq(testCases.status, 'generating'),
    columns: { id: true, prdId: true, chatThreadId: true },
  });

  // ── PRD validation threads stuck in 'validating' ──────────────────────────
  const validatingPrds = await db.query.prds.findMany({
    where: eq(prds.status, 'validating'),
    columns: { id: true, validationThreadId: true },
  });
  for (const prd of validatingPrds) {
    if (!prd.validationThreadId) {
      await db.update(prds)
        .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prd.id), eq(prds.status, 'validating')));
      recovered++;
      console.warn(
        `[recovery] PRD validating with no thread — reset to pending_review (prdId=${prd.id})`
      );
      continue;
    }
    if (isPrdValidationWatcherActive(prd.id)) continue;
    const ok = await hydrateThread(prd.validationThreadId);
    if (ok) {
      await rehydratePrdValidationWatcher(prd.id, prd.validationThreadId);
      recovered++;
      console.log(
        `[recovery] Restarted PRD validation watcher (prdId=${prd.id})`
      );

      if (isThreadIdle(prd.validationThreadId)) {
        sendMessage(prd.validationThreadId, 'Begin.').catch((err: Error) => {
          console.error(
            `[recovery] Failed to re-kick PRD validation agent (prdId=${prd.id}, threadId=${prd.validationThreadId}):`,
            err.message
          );
        });
        console.log(
          `[recovery] Re-kicked dead PRD validation agent (prdId=${prd.id})`
        );
      }
    } else {
      await db.update(prds)
        .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
        .where(and(eq(prds.id, prd.id), eq(prds.status, 'validating')));
      recovered++;
      console.warn(
        `[recovery] Could not hydrate PRD validation thread — reset to pending_review (prdId=${prd.id}, threadId=${prd.validationThreadId})`
      );
    }
  }

  for (const testCase of generatingTestCases) {
    if (!testCase.chatThreadId) continue;
    if (isTestCaseWatcherActive(testCase.id)) continue;
    const ok = await hydrateThread(testCase.chatThreadId);
    if (ok) {
      startTestCaseWatcher(testCase.id, testCase.chatThreadId);
      recovered++;
      console.log(
        `[recovery] Restarted test-case watcher (testCaseId=${testCase.id}, prdId=${testCase.prdId})`
      );

      if (isThreadIdle(testCase.chatThreadId)) {
        sendMessage(
          testCase.chatThreadId,
          'Generate QA test cases for the provided PRD and backlog. Use the configured skill instructions and write the required output files.',
          undefined,
          [],
          { hidden: true }
        ).catch((err: Error) => {
          console.error(
            `[recovery] Failed to re-kick test-case agent (testCaseId=${testCase.id}, threadId=${testCase.chatThreadId}):`,
            err.message
          );
        });
        console.log(
          `[recovery] Re-kicked dead test-case agent (testCaseId=${testCase.id})`
        );
      }
    } else {
      console.warn(
        `[recovery] Could not hydrate thread for test-case generation (testCaseId=${testCase.id}, threadId=${testCase.chatThreadId})`
      );
    }
  }

  // ── Interview threads stuck in 'running' ──────────────────────────────────
  const stuckInterviews = await findRunningInterviewThreads();
  for (const row of stuckInterviews) {
    console.log(
      `[recovery] Interview thread stuck in running` +
        ` (threadId=${row.threadId}, interviewId=${row.interviewId}` +
        `, activeRunId=${row.activeRunId ?? 'none'})`
    );

    const ok = await hydrateThread(row.threadId);
    if (ok) {
      await clearStaleRun(row.threadId);
      recovered++;
      console.log(
        `[recovery] Reset stuck interview thread to idle (threadId=${row.threadId})`
      );
    } else {
      console.warn(
        `[recovery] Could not hydrate interview thread` +
          ` (threadId=${row.threadId}, interviewId=${row.interviewId})`
      );
    }
  }

  // ── Design prototypes stuck in generating/regenerating ────────────────────
  // Prototypes are one-shot Bedrock calls (no chat thread to rehydrate), so a
  // server restart or a hung model call leaves the row orphaned. Flip rows that
  // have been transient for too long to generation_failed so the UI's existing
  // "Retry Generation" affordance unblocks the user.
  try {
    const failedPrototypes = await failStalePrototypes(STALE_PROTOTYPE_MS);
    if (failedPrototypes > 0) {
      recovered += failedPrototypes;
      console.log(
        `[recovery] Reset ${failedPrototypes} stale design prototype(s) to generation_failed`,
      );
    }
  } catch (err) {
    console.error('[recovery] Failed to reset stale design prototypes:', err);
  }

  try {
    const pdfCleanup = await expireOldSessions();
    if (pdfCleanup.expired > 0 || pdfCleanup.errors > 0) {
      console.log(
        `[recovery] PDF session cleanup completed ` +
          `(expired=${pdfCleanup.expired}, errors=${pdfCleanup.errors})`,
      );
    }
  } catch (err) {
    console.error('[recovery] Failed to clean expired PDF sessions:', err);
  }

  try {
    const featureRequestRecovered = await recoverAnalyzingFeatureRequests();
    if (featureRequestRecovered > 0) {
      recovered += featureRequestRecovered;
      console.log(
        `[recovery] Restarted ${featureRequestRecovered} feature-request analysis watcher(s)`,
      );
    }
  } catch (err) {
    console.error('[recovery] Failed to recover feature-request analysis:', err);
  }

  if (recovered > 0) {
    console.log(`[recovery] Recovered ${recovered} in-flight item(s)`);
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
    console.log(
      `[shutdown] ${signal} received — draining connections (${SHUTDOWN_GRACE_MS / 1000}s grace)…`
    );

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
