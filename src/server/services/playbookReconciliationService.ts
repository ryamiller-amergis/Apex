/**
 * TBI-021 — the correctness path, and TBI-022's only writer of `expired`.
 *
 * The latency path is a NOTIFY, and a NOTIFY is not durable. An instance that restarts between an
 * agent run finishing and its event arriving loses that event, and nothing replays it — so without
 * this sweep every suspension is one dropped message away from hanging forever. That is the whole
 * argument for the service existing, and it is why the sweep is not an optimisation to defer.
 *
 * Three query shapes in one pass, each filtered on a non-terminal status so a run that already
 * finished is never rewritten:
 *
 *   1. suspended steps whose agent run is already terminal — the missed event
 *   2. suspended steps past their deadline — the nobody-came case
 *   3. suspended steps with neither a deadline nor an agent run — orphans, which should not exist
 *      and are recorded rather than silently left
 *   4. runs settled but unfinished — every step completed, no next step started, and nothing left
 *      waiting to nudge them, because whatever would have has already fired
 *
 * The clock is injected. A sweep that reads `Date.now()` internally can only be tested by waiting,
 * and the boundary cases PBI-005 asks about — one millisecond either side of a deadline, and the
 * exact instant — are not testable by waiting at all.
 */
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { agentRuns, playbookRuns, playbookStepRuns } from '../db/schema';
import { advanceStalledRuns } from './playbookAdvanceService';
import { cursorAgentCompletionOutput } from './playbookSteps/cursorAgentCompletion';
import { failStepRun, resumeStepRun } from './playbookSteps/stepRuns';
import type { PlaybookSweepOutcome } from '../../shared/types/playbook';
import { failGatesWithEmptyCurrentPools } from './playbookGateService';
import { createDesignDocValidationAdapter, getDesignDoc } from './designDocService';
import { ingestValidationScorecard } from './documentValidationService';
import { VALIDATION_TIMEOUT_REASON } from '../../shared/utils/validationReport';

/** Agent-run statuses that mean the turn is over, one way or another. */
const TERMINAL_AGENT_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const;

export type Clock = () => Date;

const systemClock: Clock = () => new Date();

/**
 * The advisory lock key. Hashed by Postgres, following `admissionGovernorService`'s precedent.
 *
 * Without it, two instances ticking at the same moment both read the same overdue rows. The
 * conditional updates mean neither corrupts anything, but both do the work and both count it,
 * which makes the recorded outcome describe something that did not happen.
 */
export const RECONCILIATION_LOCK_KEY = 'apex_playbook_reconciliation';

let lastOutcome: PlaybookSweepOutcome | null = null;

/**
 * What the last pass did, for operational monitoring.
 *
 * TBI-021's definition of done asks for this by name, and the reason is not obvious: a sweep that
 * has silently stopped running produces exactly the same counts as a healthy sweep with nothing to
 * do. Both report zero. Only `startedAt` tells them apart.
 */
export function getLastSweepOutcome(): PlaybookSweepOutcome | null {
  return lastOutcome;
}

/** Test seam. Resets the recorded outcome so one test cannot read another's. */
export function clearLastSweepOutcome(): void {
  lastOutcome = null;
}

/**
 * Steps whose agent run finished but which never resumed.
 *
 * This is the missed NOTIFY, recovered by asking the database rather than hoping for a redelivery.
 */
async function resumeMissedTerminalEvents(): Promise<number> {
  const stranded = await db
    .select({
      stepRunId: playbookStepRuns.id,
      stepType: playbookStepRuns.stepType,
      agentRunStatus: agentRuns.status,
      agentRunId: agentRuns.id,
      threadId: agentRuns.threadId,
      completedAt: agentRuns.updatedAt,
    })
    .from(playbookStepRuns)
    .innerJoin(agentRuns, eq(playbookStepRuns.agentRunId, agentRuns.id))
    .where(
      and(
        eq(playbookStepRuns.status, 'suspended'),
        inArray(agentRuns.status, [...TERMINAL_AGENT_RUN_STATUSES])
      )
    );

  let moved = 0;
  for (const row of stranded) {
    if (row.agentRunStatus === 'completed') {
      // Same output and conditional update the event path uses, so a missed NOTIFY still
      // hands ingest-artifact a scorecard instead of an empty payload.
      if (await resumeStepRun({
        stepRunId: row.stepRunId,
        output: cursorAgentCompletionOutput({
          stepType: row.stepType,
          agentRunId: row.agentRunId,
          completedAt: row.completedAt,
          threadId: row.threadId,
        }),
      })) moved += 1;
    } else {
      await failStepRun({
        stepRunId: row.stepRunId,
        retryable: true,
        reason: `Agent run ended as ${row.agentRunStatus}; found by the reconciliation sweep.`,
      });
      moved += 1;
    }
  }

  return moved;
}

/**
 * The only place `expired` is ever written.
 *
 * `lte` rather than `lt` is PBI-005's third criterion made literal: a deadline falling exactly at
 * the sweep instant counts as passed. There is no grace margin, and that is a decision rather than
 * an oversight — a margin would mean the boundary is discovered by whoever first hits it.
 *
 * Both updates filter on a non-terminal status, which is what makes the fourth criterion — an
 * already-completed run is never overwritten — structurally true rather than a rule to remember.
 */
async function expireOverdueSuspensions(now: Date): Promise<number> {
  const expiredSteps = await db
    .update(playbookStepRuns)
    .set({
      status: 'expired',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })
    .where(
      and(
        eq(playbookStepRuns.status, 'suspended'),
        lte(playbookStepRuns.expiresAt, now.toISOString())
      )
    )
    .returning({
      id: playbookStepRuns.id,
      runId: playbookStepRuns.runId,
      stepType: playbookStepRuns.stepType,
    });

  for (const step of expiredSteps) {
    if (step.stepType === 'cursor-agent') {
      await applyExpiredValidationTimeout(step.runId);
    }
    await db
      .update(playbookRuns)
      .set({ status: 'expired', completedAt: now.toISOString(), updatedAt: now.toISOString() })
      .where(
        and(
          eq(playbookRuns.id, step.runId),
          // Never overwrite a run that already reached a terminal state.
          inArray(playbookRuns.status, ['running', 'suspended'])
        )
      );
  }

  return expiredSteps.length;
}

async function applyExpiredValidationTimeout(runId: string): Promise<void> {
  const [run] = await db
    .select({ runInput: playbookRuns.runInput })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, runId))
    .limit(1);
  const input = (run?.runInput ?? {}) as Record<string, unknown>;
  if (input.documentType !== 'design_doc' || typeof input.documentId !== 'string') return;
  if (typeof input.validationThreadId !== 'string') return;

  const document = await getDesignDoc(input.documentId);
  if (!document) return;
  await ingestValidationScorecard(
    createDesignDocValidationAdapter(input.documentId, document),
    input.validationThreadId,
    { kind: 'timeout', reason: VALIDATION_TIMEOUT_REASON },
  );
}

/**
 * Suspended steps with no path forward: no deadline and no agent run to wait on.
 *
 * BR-005 means these should not exist — `suspendStepRun` requires a deadline. They are counted
 * rather than assumed away because "cannot happen" is how a row nothing will ever look at again
 * stays invisible. A row reaching here is a bug somewhere upstream, and the count is where it
 * becomes visible.
 */
async function countOrphans(): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(playbookStepRuns)
    .where(
      and(
        eq(playbookStepRuns.status, 'suspended'),
        isNull(playbookStepRuns.expiresAt),
        isNull(playbookStepRuns.agentRunId)
      )
    );

  return row?.value ?? 0;
}

/**
 * One full pass.
 *
 * Ordered deliberately: resume before expire, so a step whose agent run finished a moment before
 * its deadline is resumed rather than expired. Getting that backwards would throw away completed
 * work on a technicality of timing.
 */
export async function runReconciliationPass(
  options: { clock?: Clock } = {}
): Promise<PlaybookSweepOutcome> {
  const clock = options.clock ?? systemClock;
  const startedAtMs = Date.now();
  const startedAt = clock().toISOString();

  try {
    const resumed = await resumeMissedTerminalEvents();
    await failGatesWithEmptyCurrentPools();
    const expired = await expireOverdueSuspensions(clock());
    const orphaned = await countOrphans();
    /*
     * Last, and after `resumeMissedTerminalEvents` rather than before it, so a step this pass has
     * just resumed gets its successor started in the same pass instead of waiting another minute.
     */
    const advanced = await advanceStalledRuns();

    lastOutcome = {
      startedAt,
      durationMs: Date.now() - startedAtMs,
      resumed,
      expired,
      orphaned,
      advanced,
    };
  } catch (error) {
    /*
     * A failed pass is recorded, not thrown. The scheduler keeps ticking: one bad pass — a
     * transient connection error, a lock timeout — should not stop reconciliation for the life of
     * the process, and the next tick is sixty seconds away.
     */
    lastOutcome = {
      startedAt,
      durationMs: Date.now() - startedAtMs,
      resumed: 0,
      expired: 0,
      orphaned: 0,
      advanced: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return lastOutcome;
}

/**
 * One pass, holding the advisory lock for its duration.
 *
 * Transaction-scoped (`pg_advisory_xact_lock`) so the lock is released by the transaction ending,
 * including when it ends badly. A session-scoped lock leaked by a crashed pass would stop every
 * instance sweeping until the connection was recycled.
 */
export async function runReconciliationPassLocked(
  options: { clock?: Clock } = {}
): Promise<PlaybookSweepOutcome> {
  return db.transaction(async () => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${RECONCILIATION_LOCK_KEY}))`);
    return runReconciliationPass(options);
  });
}
