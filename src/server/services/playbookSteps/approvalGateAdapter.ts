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
  | { outcome: 'recorded'; decision: ApprovalDecision }
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
}): Promise<ApprovalSubmissionResult> {
  const [row] = await db
    .select({
      stepRunId: playbookStepRuns.id,
      stepType: playbookStepRuns.stepType,
      status: playbookStepRuns.status,
      initiatorUserId: playbookRuns.initiatorUserId,
    })
    .from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(eq(playbookStepRuns.id, input.stepRunId))
    .limit(1);

  if (!row) {
    throw new ApprovalNotPermittedError(`No approval gate with step run id ${input.stepRunId}.`);
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
   * The authorisation check above reads the row; this write does not trust what it read. Between
   * the two, the gate may have been decided or swept. `resumeStepRun` only moves a row still marked
   * suspended, so the second of two concurrent submissions moves nothing and is told so.
   */
  const moved = await resumeStepRun({
    stepRunId: input.stepRunId,
    output: { decision: input.decision, decidedBy: input.deciderUserId },
  });

  return moved ? { outcome: 'recorded', decision: input.decision } : { outcome: 'already-decided' };
}
