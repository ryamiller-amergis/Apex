import type { Server } from 'http';
import { randomUUID } from 'crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { prds, designDocs, testCases, devSessions, agentRuns } from '../db/schema';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import {
  hydrateThread,
  isThreadIdle,
  reevaluateThreadGroundingForRecovery,
} from './chatAgentService';
import { isThreadRunAlive } from './agentRunReaperService';
import {
  startPrdWatcher,
  isPrdWatcherActive,
  isPrdValidationWatcherActive,
  rehydratePrdValidationWatcher,
  routePrdGenerationKickoff,
} from './prdService';
import {
  tryStartSingleFeatureDocWatcher,
  startValidationWatcher,
  isValidationWatcherActive,
  isDocWatcherActive,
  routeDesignDocGenerationKickoff,
} from './designDocService';
import { startTestCaseWatcher, isTestCaseWatcherActive, routeTestCaseGenerationKickoff } from './testCaseService';
import { routeDocumentValidationKickoff } from './documentValidationService';
import { failStalePrototypes } from './designPrototypeService';
import {
  findRunningInterviewThreads,
  clearStaleRun,
} from './chatThreadRepository';
import { expireOldSessions } from './pdfAssemblyService';
import { recoverAnalyzingFeatureRequests } from './featureRequestAnalysisService';
import {
  finalizeOwnedAgentRun,
  nextRunEventSequence,
  RUN_EVENT_SOURCE_INSTANCE,
} from './pgNotifyService';
import { stopReaper } from './agentRunReaperService';
import {
  NonblockingRepoCacheLeaseUnavailableError,
  RepoCacheLeaseLostError,
  withRepoCacheLease,
} from './repoCacheLeaseService';

const RECOVERY_INTERVAL_MS = 60_000;
const SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_SETUP_TIMEOUT_MS = 15 * 60_000;
const GENERATION_RECOVERY_GRACE_MS = DEFAULT_SETUP_TIMEOUT_MS;
export const RECOVERY_SWEEP_BATCH_SIZE = 100;
const RECOVERY_SWEEP_LEASE_KEY = 'startup-recovery:sweep';
const RECOVERY_SWEEP_LEASE_MS = 55_000;
const RECOVERY_SWEEP_HEARTBEAT_MS = 15_000;
/**
 * How long a design prototype may sit in `generating`/`regenerating` before the
 * recovery loop treats it as orphaned. Set well above the maximum configurable Bedrock timeout
 * (20 min) so a slow-but-live generation is never reset out from under itself.
 */
const STALE_PROTOTYPE_MS = 25 * 60_000;

let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let recoveryCyclePromise: Promise<void> | null = null;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new RepoCacheLeaseLostError();
  }
}

async function runRecoveryCategory(
  category: string,
  signal: AbortSignal | undefined,
  recover: () => Promise<void>,
): Promise<void> {
  try {
    throwIfAborted(signal);
    await recover();
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? error;
    }
    if (error instanceof RepoCacheLeaseLostError) {
      throw error;
    }
    console.error(`[recovery] Failed to recover ${category}:`, error);
  }
}

function isExpectedSweepStop(error: unknown): boolean {
  return error instanceof NonblockingRepoCacheLeaseUnavailableError
    || error instanceof RepoCacheLeaseLostError;
}

async function runRecoveryCycle(errorLabel: string): Promise<void> {
  if (recoveryCyclePromise) {
    await recoveryCyclePromise;
    return;
  }

  const cycle = (async () => {
    try {
      await withRepoCacheLease(
        RECOVERY_SWEEP_LEASE_KEY,
        async (lease) => {
          await recoverInFlightWork({ signal: lease.signal });
        },
        {
          leaseMs: RECOVERY_SWEEP_LEASE_MS,
          heartbeatMs: RECOVERY_SWEEP_HEARTBEAT_MS,
          waitMs: 0,
          releaseOnComplete: false,
        },
      );
    } catch (error) {
      if (!isExpectedSweepStop(error)) {
        console.error(errorLabel, error);
      }
    }
  })();
  recoveryCyclePromise = cycle;
  try {
    await cycle;
  } finally {
    if (recoveryCyclePromise === cycle) {
      recoveryCyclePromise = null;
    }
  }
}

function positiveDuration(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isGenerationRecoveryStale(
  updatedAt: string,
  nowMs = Date.now(),
  graceMs = GENERATION_RECOVERY_GRACE_MS,
): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs >= graceMs;
}

async function claimPrdGenerationRecovery(
  id: string,
  expectedUpdatedAt: string,
): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  const claimed = await db.update(prds)
    .set({ updatedAt: claimedAt })
    .where(and(
      eq(prds.id, id),
      eq(prds.status, 'generating'),
      eq(prds.updatedAt, expectedUpdatedAt),
    ))
    .returning({ id: prds.id });
  return claimed.length === 1;
}

async function claimDesignDocGenerationRecovery(
  id: string,
  expectedUpdatedAt: string,
): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  const claimed = await db.update(designDocs)
    .set({ updatedAt: claimedAt })
    .where(and(
      eq(designDocs.id, id),
      eq(designDocs.status, 'generating'),
      eq(designDocs.updatedAt, expectedUpdatedAt),
    ))
    .returning({ id: designDocs.id });
  return claimed.length === 1;
}

async function claimTestCaseGenerationRecovery(
  id: string,
  expectedUpdatedAt: string,
): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  const claimed = await db.update(testCases)
    .set({ updatedAt: claimedAt })
    .where(and(
      eq(testCases.id, id),
      eq(testCases.status, 'generating'),
      eq(testCases.updatedAt, expectedUpdatedAt),
    ))
    .returning({ id: testCases.id });
  return claimed.length === 1;
}

export interface StaleSetupRecoveryOptions {
  now?: () => number;
  setupTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Fail setup rows whose owner disappeared before creating a chat thread.
 * `updatedAt` is refreshed at setup phase boundaries, so this lease is separate
 * from agent-run heartbeat and meaningful-progress tracking.
 */
export async function recoverStaleDevSessionSetups(
  options: StaleSetupRecoveryOptions = {},
): Promise<number> {
  throwIfAborted(options.signal);
  const nowMs = options.now?.() ?? Date.now();
  const setupTimeoutMs = options.setupTimeoutMs
    ?? positiveDuration(process.env.DEV_SESSION_SETUP_TIMEOUT_MS, DEFAULT_SETUP_TIMEOUT_MS);
  const settingUp = await db.query.devSessions.findMany({
    where: eq(devSessions.status, 'setting_up'),
    columns: { id: true, status: true, updatedAt: true },
    orderBy: [asc(devSessions.updatedAt), asc(devSessions.id)],
    limit: RECOVERY_SWEEP_BATCH_SIZE,
  });
  let failed = 0;

  for (const session of settingUp) {
    throwIfAborted(options.signal);
    const updatedAtMs = Date.parse(session.updatedAt);
    if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs < setupTimeoutMs) continue;

    const updatedAt = new Date(nowMs).toISOString();
    const setupError = `Setup timed out after ${Math.round(setupTimeoutMs / 60_000)} minutes. The setup worker may have restarted or stopped responding; start a new development session to retry.`;
    throwIfAborted(options.signal);
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
 * Reset interview chat_threads stuck in `running` only when no live agent_runs
 * row remains. Multi-instance deployments otherwise race and clearStaleRun a
 * healthy interview mid-turn (active_run_id wiped while the owner keeps going).
 */
export interface RecoverStuckInterviewThreadsOptions {
  signal?: AbortSignal;
}

export async function recoverStuckInterviewThreads(
  options: RecoverStuckInterviewThreadsOptions = {},
): Promise<number> {
  throwIfAborted(options.signal);
  let recovered = 0;
  const stuckInterviews = await findRunningInterviewThreads();
  for (const row of stuckInterviews) {
    throwIfAborted(options.signal);
    if (await isThreadRunAlive(row.threadId)) {
      console.log(
        `[recovery] Interview thread still has a live run — leaving running` +
          ` (threadId=${row.threadId}, interviewId=${row.interviewId}` +
          `, activeRunId=${row.activeRunId ?? 'none'})`,
      );
      continue;
    }

    console.log(
      `[recovery] Interview thread stuck in running with no live agent run` +
        ` (threadId=${row.threadId}, interviewId=${row.interviewId}` +
        `, activeRunId=${row.activeRunId ?? 'none'})`,
    );

    throwIfAborted(options.signal);
    const ok = await hydrateThread(row.threadId);
    if (ok) {
      throwIfAborted(options.signal);
      await reevaluateThreadGroundingForRecovery(row.threadId);
      throwIfAborted(options.signal);
      await clearStaleRun(row.threadId);
      recovered++;
      console.log(
        `[recovery] Reset stuck interview thread to idle (threadId=${row.threadId})`,
      );
    } else {
      console.warn(
        `[recovery] Could not hydrate interview thread` +
          ` (threadId=${row.threadId}, interviewId=${row.interviewId})`,
      );
    }
  }
  return recovered;
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
 * hydration), the agent is re-kicked through the background worker so the run
 * resumes on the same lane as a fresh validation.
 * Generation agents are NOT re-kicked here — dead generation agents must be
 * retried manually via POST /design-docs/:id/retry-generate to avoid ENOENT
 * crashes from missing local workspaces.
 */
export interface RecoverInFlightWorkOptions {
  signal?: AbortSignal;
}

export async function recoverInFlightWork(
  options: RecoverInFlightWorkOptions = {},
): Promise<void> {
  const { signal } = options;
  throwIfAborted(signal);
  let recovered = 0;

  try {
    recovered += await recoverStaleDevSessionSetups({ signal });
  } catch (err) {
    if (signal?.aborted || err instanceof RepoCacheLeaseLostError) throw err;
    console.error('[recovery] Failed to recover abandoned dev session setups:', err);
  }

  await runRecoveryCategory('generating PRDs', signal, async () => {
  const generatingPrds = await db.query.prds.findMany({
    where: eq(prds.status, 'generating'),
    columns: {
      id: true,
      chatThreadId: true,
      interviewId: true,
      project: true,
      authorId: true,
      updatedAt: true,
    },
    orderBy: [asc(prds.updatedAt), asc(prds.id)],
    limit: RECOVERY_SWEEP_BATCH_SIZE,
  });
  for (const prd of generatingPrds) {
    throwIfAborted(signal);
    if (!prd.chatThreadId) continue;
    if (isPrdWatcherActive(prd.id)) continue;
    const ok = await hydrateThread(prd.chatThreadId);
    if (ok) {
      throwIfAborted(signal);
      startPrdWatcher(prd.id, prd.chatThreadId);
      recovered++;
      console.log(`[recovery] Restarted PRD watcher (prdId=${prd.id})`);

      // A worker run is created only after grounding preparation. Give a live
      // preparation a bounded lease, then atomically claim stale rows so rolling
      // or multi-instance recovery cannot start duplicate materializations.
      throwIfAborted(signal);
      const existingRun = await db.query.agentRuns.findFirst({
        where: eq(agentRuns.threadId, prd.chatThreadId),
        columns: { id: true },
      });
      if (
        !existingRun
        && isThreadIdle(prd.chatThreadId)
        && isGenerationRecoveryStale(prd.updatedAt)
        && prd.interviewId
        && prd.authorId
        && prd.project
        && await claimPrdGenerationRecovery(prd.id, prd.updatedAt)
      ) {
        void routePrdGenerationKickoff({
          prdId: prd.id,
          userId: prd.authorId,
          project: prd.project,
          threadId: prd.chatThreadId,
          interviewId: prd.interviewId,
          kickoffMessage: 'Begin.',
        }).catch((err: unknown) => {
          console.error(
            `[recovery] Failed to re-kick PRD generation (prdId=${prd.id}):`,
            err,
          );
        });
        console.log(`[recovery] Re-kicked PRD generation (prdId=${prd.id})`);
      }
    } else {
      console.warn(
        `[recovery] Could not hydrate thread for PRD (prdId=${prd.id}, threadId=${prd.chatThreadId})`
      );
    }
  }
  });

  await runRecoveryCategory('generating Design Docs', signal, async () => {
  const generatingDocs = await db.query.designDocs.findMany({
    where: eq(designDocs.status, 'generating'),
    columns: {
      id: true,
      chatThreadId: true,
      prdId: true,
      project: true,
      designPrototypeId: true,
      authorId: true,
      updatedAt: true,
    },
    orderBy: [asc(designDocs.updatedAt), asc(designDocs.id)],
    limit: RECOVERY_SWEEP_BATCH_SIZE,
  });
  for (const doc of generatingDocs) {
    throwIfAborted(signal);
    if (!doc.chatThreadId) continue;
    // Restarting a live watcher tears down its interval and builds a new one on
    // every sweep, which is far more often than a doc takes to generate. That
    // churn is what lets two watchers observe the same workspace mid-write, so
    // only adopt docs that are not already being watched here — as the PRD,
    // test-case, and validation loops do.
    if (isDocWatcherActive(doc.id)) continue;
    throwIfAborted(signal);
    const started = await tryStartSingleFeatureDocWatcher(
      doc.id,
      doc.chatThreadId,
      doc.prdId,
      doc.project,
    );
    if (started) {
      recovered++;
      console.log(
        `[recovery] Restarted design doc watcher (designDocId=${doc.id})`
      );

      // Do not mistake slow grounding preparation for an orphan. The timestamp
      // grace is the preparation lease; the compare-and-set claim ensures that
      // only one App Service instance may recover an expired lease.
      throwIfAborted(signal);
      const existingRun = await db.query.agentRuns.findFirst({
        where: eq(agentRuns.threadId, doc.chatThreadId),
        columns: { id: true },
      });
      if (
        !existingRun
        && isThreadIdle(doc.chatThreadId)
        && isGenerationRecoveryStale(doc.updatedAt)
        && doc.prdId
        && doc.authorId
        && doc.project
        && await claimDesignDocGenerationRecovery(doc.id, doc.updatedAt)
      ) {
        void Promise.resolve(
          routeDesignDocGenerationKickoff({
            designDocId: doc.id,
            prdId: doc.prdId,
            userId: doc.authorId,
            project: doc.project,
            threadId: doc.chatThreadId,
            kickoffMessage:
              `Generate the design doc. This is a non-interactive generation task — do not ask questions. Write all three output files (\`design-doc-design.md\`, \`design-doc-tech-spec.md\`, \`design-doc-assumptions.md\`) to \`.ai-pilot/output/\`.`,
          }),
        ).catch((err: unknown) => {
          console.error(
            `[recovery] Failed to re-kick design doc generation (designDocId=${doc.id}):`,
            err,
          );
        });
        console.log(`[recovery] Re-kicked design doc generation (designDocId=${doc.id})`);
      }
    }
  }
  });

  await runRecoveryCategory('validating Design Docs', signal, async () => {
  const validatingDocs = await db.query.designDocs.findMany({
    where: eq(designDocs.status, 'validating'),
    columns: {
      id: true,
      validationThreadId: true,
      chatThreadId: true,
      authorId: true,
      project: true,
    },
    orderBy: [asc(designDocs.updatedAt), asc(designDocs.id)],
    limit: RECOVERY_SWEEP_BATCH_SIZE,
  });
  for (const doc of validatingDocs) {
    throwIfAborted(signal);
    if (!doc.validationThreadId) {
      // No thread at all — stuck without any way to resume
      throwIfAborted(signal);
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
    throwIfAborted(signal);
    const ok = await hydrateThread(doc.validationThreadId);
    if (ok) {
      throwIfAborted(signal);
      startValidationWatcher(doc.id, doc.validationThreadId);
      recovered++;
      console.log(
        `[recovery] Restarted validation watcher (designDocId=${doc.id})`
      );

      // If the agent was killed mid-run (thread is idle after hydration), re-kick
      // it so the validation run actually resumes rather than the watcher polling forever.
      // Skip re-kick when another instance still owns a live run.
      const validationRunAlive = await isThreadRunAlive(doc.validationThreadId);
      throwIfAborted(signal);
      if (isThreadIdle(doc.validationThreadId) && !validationRunAlive) {
        throwIfAborted(signal);
        if (doc.authorId && doc.project) {
          throwIfAborted(signal);
          void routeDocumentValidationKickoff({
            userId: doc.authorId,
            project: doc.project,
            threadId: doc.validationThreadId,
            documentId: doc.id,
            sourceThreadId: doc.chatThreadId,
            onFailure: async () => undefined,
          }).catch((err: unknown) => {
            console.error(
              `[recovery] Failed to re-kick validation (designDocId=${doc.id}):`,
              err,
            );
          });
        } else {
          console.warn(
            `[recovery] Cannot re-kick validation without author/project (designDocId=${doc.id})`,
          );
        }
        console.log(
          `[recovery] Re-kicked dead validation agent (designDocId=${doc.id})`
        );
      }
    } else {
      const validationRunAlive = await isThreadRunAlive(doc.validationThreadId);
      throwIfAborted(signal);
      if (!validationRunAlive) {
      // Thread is unrecoverable and no other instance owns a live run —
      // reset so the doc is not stuck forever.
        throwIfAborted(signal);
        await db.update(designDocs)
          .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
          .where(and(eq(designDocs.id, doc.id), eq(designDocs.status, 'validating')));
        recovered++;
        console.warn(
          `[recovery] Could not hydrate validation thread — reset to pending_review (designDocId=${doc.id}, threadId=${doc.validationThreadId})`
        );
      } else {
        console.warn(
          `[recovery] Could not hydrate validation thread but run is still alive elsewhere — leaving validating (designDocId=${doc.id}, threadId=${doc.validationThreadId})`
        );
      }
    }
  }
  });

  // ── PRD validation threads stuck in 'validating' ──────────────────────────
  await runRecoveryCategory('validating PRDs', signal, async () => {
  const validatingPrds = await db.query.prds.findMany({
    where: eq(prds.status, 'validating'),
    columns: {
      id: true,
      validationThreadId: true,
      chatThreadId: true,
      authorId: true,
      project: true,
    },
    orderBy: [asc(prds.updatedAt), asc(prds.id)],
    limit: RECOVERY_SWEEP_BATCH_SIZE,
  });
  for (const prd of validatingPrds) {
    throwIfAborted(signal);
    if (!prd.validationThreadId) {
      throwIfAborted(signal);
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
    throwIfAborted(signal);
    const ok = await hydrateThread(prd.validationThreadId);
    if (ok) {
      throwIfAborted(signal);
      await rehydratePrdValidationWatcher(prd.id, prd.validationThreadId);
      recovered++;
      console.log(
        `[recovery] Restarted PRD validation watcher (prdId=${prd.id})`
      );

      const validationRunAlive = await isThreadRunAlive(prd.validationThreadId);
      throwIfAborted(signal);
      if (isThreadIdle(prd.validationThreadId) && !validationRunAlive) {
        throwIfAborted(signal);
        if (prd.authorId && prd.project) {
          throwIfAborted(signal);
          void routeDocumentValidationKickoff({
            userId: prd.authorId,
            project: prd.project,
            threadId: prd.validationThreadId,
            documentId: prd.id,
            sourceThreadId: prd.chatThreadId,
            onFailure: async () => undefined,
          }).catch((err: unknown) => {
            console.error(
              `[recovery] Failed to re-kick PRD validation (prdId=${prd.id}):`,
              err,
            );
          });
        } else {
          console.warn(
            `[recovery] Cannot re-kick PRD validation without author/project (prdId=${prd.id})`,
          );
        }
        console.log(
          `[recovery] Re-kicked dead PRD validation agent (prdId=${prd.id})`
        );
      }
    } else {
      const validationRunAlive = await isThreadRunAlive(prd.validationThreadId);
      throwIfAborted(signal);
      if (!validationRunAlive) {
        throwIfAborted(signal);
        await db.update(prds)
          .set({ status: 'pending_review', updatedAt: new Date().toISOString() })
          .where(and(eq(prds.id, prd.id), eq(prds.status, 'validating')));
        recovered++;
        console.warn(
          `[recovery] Could not hydrate PRD validation thread — reset to pending_review (prdId=${prd.id}, threadId=${prd.validationThreadId})`
        );
      } else {
        console.warn(
          `[recovery] Could not hydrate PRD validation thread but run is still alive elsewhere — leaving validating (prdId=${prd.id}, threadId=${prd.validationThreadId})`
        );
      }
    }
  }
  });

  await runRecoveryCategory('generating test cases', signal, async () => {
  const generatingTestCases = await db.query.testCases.findMany({
    where: eq(testCases.status, 'generating'),
    columns: { id: true, prdId: true, chatThreadId: true, updatedAt: true },
    orderBy: [asc(testCases.updatedAt), asc(testCases.id)],
    limit: RECOVERY_SWEEP_BATCH_SIZE,
  });
  for (const testCase of generatingTestCases) {
    throwIfAborted(signal);
    if (!testCase.chatThreadId) continue;
    if (isTestCaseWatcherActive(testCase.id)) continue;
    throwIfAborted(signal);
    const ok = await hydrateThread(testCase.chatThreadId);
    if (ok) {
      throwIfAborted(signal);
      startTestCaseWatcher(testCase.id, testCase.chatThreadId);
      recovered++;
      console.log(
        `[recovery] Restarted test-case watcher (testCaseId=${testCase.id}, prdId=${testCase.prdId})`
      );

      if (
        isThreadIdle(testCase.chatThreadId)
        && !(await isThreadRunAlive(testCase.chatThreadId))
        && isGenerationRecoveryStale(testCase.updatedAt)
        && await claimTestCaseGenerationRecovery(testCase.id, testCase.updatedAt)
      ) {
        throwIfAborted(signal);
        const prd = await db.query.prds.findFirst({
          where: eq(prds.id, testCase.prdId),
          columns: { authorId: true, project: true, chatThreadId: true },
        });
        if (prd?.authorId && prd.project) {
          void routeTestCaseGenerationKickoff({
            testCaseId: testCase.id,
            prdId: testCase.prdId,
            userId: prd.authorId,
            project: prd.project,
            threadId: testCase.chatThreadId,
            sourceThreadId: prd.chatThreadId ?? testCase.chatThreadId,
          }).catch((err: unknown) => {
            console.error(
              `[recovery] Failed to re-kick test-case generation (testCaseId=${testCase.id}):`,
              err,
            );
          });
          console.log(
            `[recovery] Re-kicked test-case generation (testCaseId=${testCase.id})`
          );
        } else {
          console.warn(
            `[recovery] Cannot re-kick test-case generation without PRD author/project (testCaseId=${testCase.id}, prdId=${testCase.prdId})`
          );
        }
      }
    } else {
      console.warn(
        `[recovery] Could not hydrate thread for test-case generation (testCaseId=${testCase.id}, threadId=${testCase.chatThreadId})`
      );
    }
  }
  });

  // ── Interview threads stuck in 'running' ──────────────────────────────────
  try {
    throwIfAborted(signal);
    recovered += await recoverStuckInterviewThreads({ signal });
  } catch (err) {
    if (signal?.aborted || err instanceof RepoCacheLeaseLostError) throw err;
    console.error('[recovery] Failed to recover stuck interview threads:', err);
  }

  // ── Design prototypes stuck in generating/regenerating ────────────────────
  // Prototypes are one-shot Bedrock calls (no chat thread to rehydrate), so a
  // server restart or a hung model call leaves the row orphaned. Flip rows that
  // have been transient for too long to generation_failed so the UI's existing
  // "Retry Generation" affordance unblocks the user.
  try {
    throwIfAborted(signal);
    const failedPrototypes = await failStalePrototypes(STALE_PROTOTYPE_MS);
    if (failedPrototypes > 0) {
      recovered += failedPrototypes;
      console.log(
        `[recovery] Reset ${failedPrototypes} stale design prototype(s) to generation_failed`,
      );
    }
  } catch (err) {
    if (signal?.aborted || err instanceof RepoCacheLeaseLostError) throw err;
    console.error('[recovery] Failed to reset stale design prototypes:', err);
  }

  try {
    throwIfAborted(signal);
    const pdfCleanup = await expireOldSessions();
    if (pdfCleanup.expired > 0 || pdfCleanup.errors > 0) {
      console.log(
        `[recovery] PDF session cleanup completed ` +
          `(expired=${pdfCleanup.expired}, errors=${pdfCleanup.errors})`,
      );
    }
  } catch (err) {
    if (signal?.aborted || err instanceof RepoCacheLeaseLostError) throw err;
    console.error('[recovery] Failed to clean expired PDF sessions:', err);
  }

  try {
    throwIfAborted(signal);
    const featureRequestRecovered = await recoverAnalyzingFeatureRequests();
    if (featureRequestRecovered > 0) {
      recovered += featureRequestRecovered;
      console.log(
        `[recovery] Restarted ${featureRequestRecovered} feature-request analysis watcher(s)`,
      );
    }
  } catch (err) {
    if (signal?.aborted || err instanceof RepoCacheLeaseLostError) throw err;
    console.error('[recovery] Failed to recover feature-request analysis:', err);
  }

  throwIfAborted(signal);
  if (recovered > 0) {
    console.log(`[recovery] Recovered ${recovered} in-flight item(s)`);
  }
}

/**
 * Run initial recovery, then schedule periodic checks to catch work that
 * was orphaned by a previous instance dying after this one started.
 */
export function startRecoveryLoop(): void {
  if (recoveryTimer) {
    return;
  }

  void runRecoveryCycle('[recovery] Initial recovery failed:');
  recoveryTimer = setInterval(() => {
    void runRecoveryCycle('[recovery] Periodic recovery failed:');
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();
}

export function stopRecoveryLoop(): void {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

function isPipeClosedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

/**
 * Prevent Cursor SDK local-CLI pipe failures (EPIPE) from taking down the whole
 * App Service process. Prod 2026-07-28: unhandled EPIPE from @cursor/sdk crashed
 * Node while design-doc agents were running, then apt-blocked restart prolonged
 * the outage.
 *
 * Non-EPIPE fatals still exit after logging so Azure can recycle cleanly.
 */
export function registerProcessGuards(): void {
  process.on('uncaughtException', (err) => {
    if (isPipeClosedError(err)) {
      console.error(
        '[process] Ignoring uncaught EPIPE/stream error (Cursor SDK CLI pipe likely closed):',
        err,
      );
      return;
    }
    console.error('[process] Uncaught exception — exiting after log:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    if (isPipeClosedError(reason)) {
      console.error(
        '[process] Ignoring unhandled EPIPE/stream rejection (Cursor SDK CLI pipe likely closed):',
        reason,
      );
      return;
    }
    console.error('[process] Unhandled promise rejection:', reason);
  });
}

export interface FinalizeOwnedRunsForShutdownOptions {
  ownerInstance?: string;
  now?: () => number;
}

export async function finalizeOwnedRunsForShutdown(
  options: FinalizeOwnedRunsForShutdownOptions = {},
): Promise<number> {
  const ownerInstance = options.ownerInstance ?? RUN_EVENT_SOURCE_INSTANCE;
  const timestamp = new Date(options.now?.() ?? Date.now()).toISOString();
  const detail = 'Agent run interrupted by owner shutdown';
  const rows = await db.query.agentRuns.findMany({
    where: and(
      eq(agentRuns.ownerInstance, ownerInstance),
      inArray(agentRuns.status, ['queued', 'running']),
    ),
    columns: { id: true, threadId: true },
  });
  let finalized = 0;
  for (const row of rows) {
    const events: AgentRunEventEnvelope[] = [
      {
        eventId: randomUUID(),
        threadId: row.threadId,
        runId: row.id,
        sourceInstance: ownerInstance,
        sequence: nextRunEventSequence(row.id, ownerInstance),
        timestamp,
        type: 'error',
        phase: 'completion',
        status: 'failed',
        detail,
        event: { type: 'error', error: detail },
      },
      {
        eventId: randomUUID(),
        threadId: row.threadId,
        runId: row.id,
        sourceInstance: ownerInstance,
        sequence: nextRunEventSequence(row.id, ownerInstance),
        timestamp,
        type: 'done',
        phase: 'completion',
        status: 'completed',
        detail: 'Run completed',
        event: { type: 'done', runId: row.id },
      },
    ];
    if (await finalizeOwnedAgentRun({
      runId: row.id,
      threadId: row.threadId,
      ownerInstance,
      status: 'failed',
      detail,
      events,
    })) {
      finalized += 1;
    }
  }
  return finalized;
}

/**
 * Register SIGTERM / SIGINT handlers for graceful shutdown.
 * Stops accepting new connections and waits for in-flight requests
 * before exiting so rolling deployments don't drop requests.
 */
export function registerGracefulShutdown(server: Server): void {
  let shuttingDown = false;

  registerProcessGuards();

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `[shutdown] ${signal} received — draining connections (${SHUTDOWN_GRACE_MS / 1000}s grace)…`
    );

    stopRecoveryLoop();
    stopReaper();

    const finalization = finalizeOwnedRunsForShutdown()
      .then((count) => {
        console.log(`[shutdown] Finalized ${count} owned non-terminal run(s)`);
      })
      .catch((error) => {
        console.error('[shutdown] Failed to finalize owned agent runs:', error);
      });

    server.close(() => {
      void finalization.finally(() => {
        console.log('[shutdown] All connections drained — exiting');
        process.exit(0);
      });
    });

    setTimeout(() => {
      console.warn('[shutdown] Grace period expired — forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
