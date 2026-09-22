/**
 * The suspend/resume primitive, and the only place a step run's status is written.
 *
 * BR-008 says a human approval gate and an agent-step completion share one primitive. The interview
 * called that the strongest single reason the engine earns its place, so it is worth being literal
 * about: `approval-gate` and `cursor-agent` call the same `suspendStepRun` and the same
 * `resumeStepRun` here, and differ only in what causes the resume. Two parallel suspension
 * mechanisms would mean the reconciliation sweep in FEAT-005 has to cover both, and it will only
 * ever be written against one.
 *
 * Every state move is a conditional update guarded on the status the caller expects to find. That
 * is what makes resume idempotent: a duplicate approval, or a terminal agent-run event delivered
 * twice, affects zero rows and is reported as "already moved" rather than advancing the run a
 * second time. At-least-once delivery is the normal case, not the exceptional one.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../../db/schema';
import { assertSuspendedRunCapacity } from '../playbookGuardService';
import type {
  PlaybookGraph,
  PlaybookStepRun,
  PlaybookStepRunStatus,
} from '../../../shared/types/playbook';

/** What an adapter reports back after executing. */
export type PlaybookStepOutcome =
  | { kind: 'completed'; output?: Record<string, unknown> }
  | { kind: 'suspended'; expiresAt: string; agentRunId?: string };

/** Everything an adapter is given. Adapters read this and touch no global state. */
export interface PlaybookStepExecutionContext {
  runId: string;
  stepRunId: string;
  stepId: string;
  stepType: string;
  project: string;
  /** Every step executes as the run's initiator, never a service principal (BR-003). */
  initiatorUserId: string;
  config: Record<string, unknown>;
  graph?: PlaybookGraph;
}

export type PlaybookStepAdapter = (
  context: PlaybookStepExecutionContext
) => Promise<PlaybookStepOutcome>;

export class PlaybookStepRunNotFoundError extends Error {
  constructor(stepRunId: string) {
    super(`No playbook step run with id ${stepRunId}.`);
    this.name = 'PlaybookStepRunNotFoundError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Creates the row for a step about to execute, and marks it running in the same insert. */
export async function beginStepRun(input: {
  runId: string;
  stepId: string;
  stepType: string;
  inputInline?: Record<string, unknown>;
}): Promise<PlaybookStepRun> {
  const [row] = await db
    .insert(playbookStepRuns)
    .values({
      runId: input.runId,
      stepId: input.stepId,
      stepType: input.stepType,
      status: 'running',
      inputInline: input.inputInline,
      startedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: [playbookStepRuns.runId, playbookStepRuns.stepId],
      set: {
        status: 'running',
        inputInline: input.inputInline,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      },
      setWhere: eq(playbookStepRuns.status, 'pending'),
    })
    .returning();

  return row as unknown as PlaybookStepRun;
}

/** Persists a future step's resolved inputs so a preceding gate can render them. */
export async function prepareStepRun(input: {
  runId: string;
  stepId: string;
  stepType: string;
  inputInline: Record<string, unknown>;
}): Promise<void> {
  await db.insert(playbookStepRuns).values({
    runId: input.runId,
    stepId: input.stepId,
    stepType: input.stepType,
    status: 'pending',
    inputInline: input.inputInline,
  }).onConflictDoNothing();
}

/**
 * Parks a step.
 *
 * `expiresAt` is required rather than optional, which is BR-005 expressed in a signature: a
 * suspension with no deadline is a run that waits forever, and the reconciliation sweep finds
 * nothing to end because its index is over `expires_at`. Making the caller pass one means the rule
 * cannot be forgotten at the one call site that matters.
 */
export async function suspendStepRun(input: {
  stepRunId: string;
  expiresAt: string;
  agentRunId?: string;
  resumeToken?: string;
}): Promise<void> {
  /*
   * The run is loaded first because two things here need it: TBI-023's suspended-run ceiling is
   * per project, and the run's own status has to follow the step's. A parked step whose run still
   * reads `running` would make both concurrency counters lie — every suspension would count
   * against the active cap and none against the ceiling, which is exactly the collision the two
   * separate counters exist to avoid.
   */
  const [context] = await db
    .select({
      runId: playbookStepRuns.runId,
      project: playbookRuns.project,
      stepStatus: playbookStepRuns.status,
    })
    .from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(eq(playbookStepRuns.id, input.stepRunId))
    .limit(1);

  if (!context) {
    throw new PlaybookStepRunNotFoundError(input.stepRunId);
  }

  // Admission, before any write: a refused suspension must leave the step exactly as it was.
  await assertSuspendedRunCapacity(context.project, context.runId);

  const updated = await db
    .update(playbookStepRuns)
    .set({
      status: 'suspended',
      expiresAt: input.expiresAt,
      ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
      ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(playbookStepRuns.id, input.stepRunId),
        // Only a step that is actually executing may be parked. Suspending an already-suspended
        // step would silently extend its deadline, which is how a gate outlives the thing it gates.
        eq(playbookStepRuns.status, 'running')
      )
    )
    .returning({ id: playbookStepRuns.id });

  if (updated.length === 0) {
    throw new PlaybookStepRunNotFoundError(input.stepRunId);
  }

  await db
    .update(playbookRuns)
    .set({ status: 'suspended', updatedAt: nowIso() })
    .where(and(eq(playbookRuns.id, context.runId), eq(playbookRuns.status, 'running')));
}

/**
 * Advances a suspended step. Returns false when it had already moved.
 *
 * The false return is the whole idempotence story, and it is deliberately not an error: a duplicate
 * approval submission and a redelivered terminal agent-run event are both ordinary, and TBI-018's
 * definition of done asks for a no-op rather than something that "corrupts state". The caller
 * decides whether to care; nothing here treats it as a problem.
 */
export async function resumeStepRun(input: {
  stepRunId: string;
  output?: Record<string, unknown>;
}): Promise<boolean> {
  const moved = await db
    .update(playbookStepRuns)
    .set({
      status: 'completed',
      ...(input.output ? { outputInline: input.output } : {}),
      completedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(eq(playbookStepRuns.id, input.stepRunId), eq(playbookStepRuns.status, 'suspended'))
    )
    .returning({ id: playbookStepRuns.id, runId: playbookStepRuns.runId });

  if (moved.length === 0) return false;

  /*
   * Only the caller that actually moved the step puts the run back to running, which is what keeps
   * a redelivered event from reviving a run that has since been cancelled or expired: the second
   * delivery returns above without reaching this.
   */
  await db
    .update(playbookRuns)
    .set({ status: 'running', updatedAt: nowIso() })
    .where(and(eq(playbookRuns.id, moved[0].runId), eq(playbookRuns.status, 'suspended')));

  return true;
}

/** Marks a step finished. Used by non-suspending steps, which complete in the same tick they start. */
export async function completeStepRun(input: {
  stepRunId: string;
  output?: Record<string, unknown>;
}): Promise<void> {
  const updated = await db
    .update(playbookStepRuns)
    .set({
      status: 'completed',
      ...(input.output ? { outputInline: input.output } : {}),
      completedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(playbookStepRuns.id, input.stepRunId),
        inArray(playbookStepRuns.status, ['pending', 'running'])
      )
    )
    .returning({ id: playbookStepRuns.id });

  if (updated.length === 0) {
    throw new PlaybookStepRunNotFoundError(input.stepRunId);
  }
}

/**
 * Completes a step only if it is still open. Returns false when it had already moved.
 *
 * The same shape as `resumeStepRun`'s conditional update, and for a related reason. Adapters own
 * their own status writes — `notify` completes its row, `approval-gate` and `cursor-agent` suspend
 * theirs — so by the time the orchestrator sees a `completed` outcome the row usually already says
 * so. Calling `completeStepRun` there would throw on the ordinary path.
 *
 * It exists rather than the orchestrator simply trusting the adapter because an adapter that
 * reports `completed` without writing a row leaves the step stuck at `running`, and a step stuck at
 * `running` stalls the run at the next advance with nothing to show why.
 */
export async function completeStepRunIfOpen(input: {
  stepRunId: string;
  output?: Record<string, unknown>;
}): Promise<boolean> {
  const updated = await db
    .update(playbookStepRuns)
    .set({
      status: 'completed',
      ...(input.output ? { outputInline: input.output } : {}),
      completedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(playbookStepRuns.id, input.stepRunId),
        inArray(playbookStepRuns.status, ['pending', 'running'])
      )
    )
    .returning({ id: playbookStepRuns.id });

  return updated.length > 0;
}

/**
 * Marks a step failed.
 *
 * `retryable` writes `failed_retryable`, which exists on steps but not on runs. It is what a live
 * agent step becomes when the process dies mid-turn: Cursor work cannot resume mid-turn, so the
 * step is parked for a person to retry rather than failing the whole run or being retried
 * automatically, which is what the ADR's exit criterion asks for.
 */
export async function failStepRun(input: {
  stepRunId: string;
  retryable?: boolean;
  reason?: string;
}): Promise<void> {
  const status: PlaybookStepRunStatus = input.retryable ? 'failed_retryable' : 'failed';

  await db
    .update(playbookStepRuns)
    .set({
      status,
      ...(input.reason ? { outputInline: { error: input.reason } } : {}),
      completedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(playbookStepRuns.id, input.stepRunId),
        inArray(playbookStepRuns.status, ['pending', 'running', 'suspended'])
      )
    );
}

/**
 * Parks a step for a person and suspends its run, in one transaction. Returns false when there was
 * no open step to park.
 *
 * TBI-035's refusal has two halves and neither is useful alone. A step at `failed_retryable` whose
 * run still reads `running` is a run the engine keeps advancing, straight past the step the refusal
 * exists to stop; a run at `suspended` with no parked step is a run nobody can explain. Both moves
 * are conditional for the same reason every other move in this file is — a step that has already
 * gone terminal is left as it is, and a run that has already completed, been cancelled or expired
 * is not brought back to life.
 *
 * Nothing here retries. `failed_retryable` names what a person may do next, not something this
 * code will do on their behalf.
 */
export async function failStepRunForHuman(input: {
  stepRunId: string;
  reason: string;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const parked = await tx
      .update(playbookStepRuns)
      .set({
        status: 'failed_retryable',
        outputInline: { error: input.reason },
        completedAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(playbookStepRuns.id, input.stepRunId),
          inArray(playbookStepRuns.status, ['pending', 'running', 'suspended'])
        )
      )
      .returning({ id: playbookStepRuns.id, runId: playbookStepRuns.runId });

    // Absent or already terminal: the run is not the caller's to move on the strength of a step
    // this call did not park.
    if (parked.length === 0) return false;

    await tx
      .update(playbookRuns)
      .set({ status: 'suspended', updatedAt: nowIso() })
      .where(
        and(
          eq(playbookRuns.id, parked[0].runId),
          inArray(playbookRuns.status, ['running', 'suspended'])
        )
      );

    return true;
  });
}

export async function getStepRun(stepRunId: string): Promise<PlaybookStepRun | null> {
  const row = await db.query.playbookStepRuns.findFirst({
    where: eq(playbookStepRuns.id, stepRunId),
  });
  return (row as unknown as PlaybookStepRun) ?? null;
}

/** Turns a deadline in milliseconds into the absolute instant the sweep will compare against. */
export function deadlineFromNow(deadlineMs: number): string {
  return new Date(Date.now() + deadlineMs).toISOString();
}
