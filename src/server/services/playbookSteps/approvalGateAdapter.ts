/**
 * The `approval-gate` step type.
 *
 * This and `cursor-agent` are the pair BR-008 is about: a human decision and a machine completion
 * resume through the same `suspendStepRun` / `resumeStepRun` primitive, differing only in what
 * causes the resume. The interview called that the strongest single argument for adopting an engine
 * at all, so the adapter deliberately has no suspension machinery of its own — if it grew any, the
 * reconciliation sweep FEAT-005 builds would have two shapes to cover and would be written against
 * one.
 *
 * Idempotence comes from the conditional update rather than from a check-then-write. A duplicate
 * approval — a double-clicked button, a retried request — matches zero rows because the status is
 * no longer `suspended`, and is reported as already-decided. Reading the row first and then writing
 * would leave a window between the two where a second submission sees `suspended` as well.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../../db/schema';
import { resolveDeadlineMs } from './registry';
import {
  deadlineFromNow,
  resumeStepRun,
  suspendStepRun,
  PlaybookStepExecutionContext,
  PlaybookStepOutcome,
} from './stepRuns';
import type { ApprovalGateStepConfig } from '../../../shared/types/playbook';

const STEP_TYPE = 'approval-gate';

export type ApprovalDecision = 'approved' | 'rejected';

/** Why a decision was refused, when it was. */
export type ApprovalSubmissionResult =
  /**
   * `stepId` is the graph node, not the row. It is what the engine is parked at, so returning it
   * lets the route say which step to carry on from instead of having it worked out from timestamps.
   */
  | { outcome: 'recorded'; decision: ApprovalDecision; stepId: string }
  /** The gate had already been decided, or had expired. Not an error — see the file comment. */
  | { outcome: 'already-decided' };

export class ApprovalGateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalGateConfigError';
  }
}

export class ApprovalNotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalNotPermittedError';
  }
}

/**
 * The gate is parked but carries no deadline, which BR-005 says cannot happen.
 *
 * Refusing rather than approving anyway is PBI-004's third criterion, and the reasoning is that a
 * suspension with no deadline is invisible to the sweep — nothing will ever end it. Resuming it
 * quietly would clear the symptom and leave the write path that produced it intact.
 */
export class ApprovalMissingDeadlineError extends Error {
  constructor(stepRunId: string) {
    super(
      `Approval gate ${stepRunId} is suspended with no deadline recorded, which should not be ` +
        'possible. Refusing to resume a suspension the reconciliation sweep cannot see.'
    );
    this.name = 'ApprovalMissingDeadlineError';
  }
}

/**
 * The step is not parked awaiting a decision, and never was decided either.
 *
 * Distinct from a duplicate approval, which is a no-op. The difference is whether the gate was
 * ever suspended: a decided gate has been, and the caller is simply late; a `running` or `pending`
 * step has not, and approving it would be approving something that has not asked yet.
 */
export class ApprovalNotAwaitingError extends Error {
  constructor(stepRunId: string, status: string) {
    super(
      `Playbook step ${stepRunId} is ${status} and is not awaiting approval.`
    );
    this.name = 'ApprovalNotAwaitingError';
  }
}

export function parseApprovalGateConfig(
  config: Record<string, unknown>
): ApprovalGateStepConfig {
  const { deadlineMs, subject } = config;

  if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs))) {
    throw new ApprovalGateConfigError(
      "An approval gate's deadlineMs must be a finite number of milliseconds when set."
    );
  }
  if (subject !== undefined && typeof subject !== 'string') {
    throw new ApprovalGateConfigError("An approval gate's subject must be a string when set.");
  }

  return { deadlineMs: deadlineMs as number | undefined, subject: subject as string | undefined };
}

export async function executeApprovalGateStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  const config = parseApprovalGateConfig(context.config);

  // The registry owns both the 48-hour default and whether a definition may override it, so an
  // out-of-range or disallowed override is refused there rather than quietly clamped here.
  const expiresAt = deadlineFromNow(resolveDeadlineMs(STEP_TYPE, config.deadlineMs));

  await suspendStepRun({ stepRunId: context.stepRunId, expiresAt });

  return { kind: 'suspended', expiresAt };
}

/**
 * Records a decision on a parked gate.
 *
 * Phase 0 permits exactly one decider: the person who started the run. That is BR-003 rather than a
 * simplification for its own sake — the run acts as its initiator throughout, and a pool of
 * eligible approvers is Epic 3's work. Approving on someone else's behalf is refused rather than
 * ignored, because a gate that silently accepts the wrong signature is worse than one that rejects
 * the right person.
 */
export async function submitApprovalDecision(input: {
  stepRunId: string;
  deciderUserId: string;
  decision: ApprovalDecision;
  /** When given, the step must belong to this run. The route passes the id from its path. */
  runId?: string;
}): Promise<ApprovalSubmissionResult> {
  const [row] = await db
    .select({
      stepRunId: playbookStepRuns.id,
      runId: playbookStepRuns.runId,
      stepId: playbookStepRuns.stepId,
      stepType: playbookStepRuns.stepType,
      status: playbookStepRuns.status,
      expiresAt: playbookStepRuns.expiresAt,
      initiatorUserId: playbookRuns.initiatorUserId,
    })
    .from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(eq(playbookStepRuns.id, input.stepRunId))
    .limit(1);

  if (!row) {
    throw new ApprovalNotPermittedError(`No approval gate with step run id ${input.stepRunId}.`);
  }

  if (input.runId && row.runId !== input.runId) {
    // Refused as not-found rather than mismatched: confirming a step exists under another run is
    // more than the caller has established a right to know.
    throw new ApprovalNotPermittedError(
      `No approval gate with step run id ${input.stepRunId} on run ${input.runId}.`
    );
  }

  if (row.stepType !== STEP_TYPE) {
    throw new ApprovalNotPermittedError(
      `Step run ${input.stepRunId} is a ${row.stepType} step, not an approval gate.`
    );
  }

  if (row.initiatorUserId !== input.deciderUserId) {
    throw new ApprovalNotPermittedError(
      'Only the person who started this run may decide its approval gates.'
    );
  }

  /*
   * Ordered so the two non-suspended cases are told apart, which PBI-004 needs and the status
   * alone does not give: a decided gate and a gate that never parked both read as "not
   * suspended". A gate that reached `completed` or `expired` was suspended once, so a decision
   * arriving now is simply late — a no-op. A `pending` or `running` step never asked for one.
   */
  if (row.status !== 'suspended') {
    if (row.status === 'completed' || row.status === 'expired') {
      return { outcome: 'already-decided' };
    }
    throw new ApprovalNotAwaitingError(input.stepRunId, row.status);
  }

  if (!row.expiresAt) {
    throw new ApprovalMissingDeadlineError(input.stepRunId);
  }

  /*
   * The authorisation check above reads the row; this write does not trust what it read. Between
   * the two, the gate may have been decided or swept. `resumeStepRun` only moves a row still marked
   * suspended, so the second of two concurrent submissions moves nothing and is told so.
   */
  const moved = await resumeStepRun({
    stepRunId: input.stepRunId,
    output: { decision: input.decision, decidedBy: input.deciderUserId },
  });

  return moved
    ? { outcome: 'recorded', decision: input.decision, stepId: row.stepId }
    : { outcome: 'already-decided' };
}
