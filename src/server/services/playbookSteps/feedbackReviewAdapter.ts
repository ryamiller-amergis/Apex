/**
 * The reusable `feedback-review` step.
 *
 * It parks the run until the person who started it chooses what to do with each item from the
 * AI steps the author selected. It does not discover other agents, and it does not change a skill.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../../db/schema';
import {
  feedbackDecision,
  feedbackItemKey,
  noteRequired,
  promptsForSources,
  revisionBrief,
  type FeedbackReviewItem,
} from '../../../shared/feedbackReview';
import type { FeedbackReviewStepConfig } from '../../../shared/types/playbook';
import { parseStepInput, parseStepOutput } from './descriptorValidation';
import { resolveDeadlineMs } from './registry';
import {
  deadlineFromNow,
  resumeStepRun,
  suspendStepRun,
  type PlaybookStepExecutionContext,
  type PlaybookStepOutcome,
} from './stepRuns';

const STEP_TYPE = 'feedback-review';

export type FeedbackSubmissionResult =
  | { outcome: 'recorded'; decision: 'accepted' | 'needs_changes' | 'rejected'; stepId: string }
  | { outcome: 'already-decided' };

export class FeedbackNotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackNotPermittedError';
  }
}

export class FeedbackNotAwaitingError extends Error {
  constructor(stepRunId: string, status: string) {
    super(`Playbook step ${stepRunId} is ${status} and is not awaiting feedback.`);
    this.name = 'FeedbackNotAwaitingError';
  }
}

export class FeedbackMissingDeadlineError extends Error {
  constructor(stepRunId: string) {
    super(
      `Feedback review ${stepRunId} is suspended with no deadline recorded. ` +
        'Refusing to resume a suspension the reconciliation sweep cannot see.'
    );
    this.name = 'FeedbackMissingDeadlineError';
  }
}

export class FeedbackInvalidItemsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedbackInvalidItemsError';
  }
}

export async function executeFeedbackReviewStep(
  context: PlaybookStepExecutionContext
): Promise<PlaybookStepOutcome> {
  const config = parseStepInput<FeedbackReviewStepConfig>(STEP_TYPE, context.config);
  const expiresAt = deadlineFromNow(resolveDeadlineMs(STEP_TYPE, config.deadlineMs));
  await suspendStepRun({ stepRunId: context.stepRunId, expiresAt });
  return { kind: 'suspended', expiresAt };
}

function cleanItems(value: unknown): FeedbackReviewItem[] | null {
  if (!Array.isArray(value)) return null;
  const items: FeedbackReviewItem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const source = entry as Record<string, unknown>;
    const sourceStepId = typeof source.sourceStepId === 'string' ? source.sourceStepId.trim() : '';
    const itemId = typeof source.itemId === 'string' ? source.itemId.trim() : '';
    const action = source.action;
    const note = typeof source.note === 'string' ? source.note.trim() : '';
    if (
      !sourceStepId ||
      !itemId ||
      (action !== 'accept' &&
        action !== 'question' &&
        action !== 'override' &&
        action !== 'reject' &&
        action !== 'defer')
    ) {
      return null;
    }
    if (noteRequired(action) && !note) return null;
    items.push({
      sourceStepId,
      itemId,
      action,
      ...(note ? { note: note.slice(0, 2000) } : {}),
    });
  }
  return items;
}

export async function submitFeedbackReview(input: {
  stepRunId: string;
  deciderUserId: string;
  runId?: string;
  stopped: boolean;
  comment?: string;
  items: unknown;
}): Promise<FeedbackSubmissionResult> {
  const [row] = await db
    .select({
      stepRunId: playbookStepRuns.id,
      runId: playbookStepRuns.runId,
      stepId: playbookStepRuns.stepId,
      stepType: playbookStepRuns.stepType,
      status: playbookStepRuns.status,
      expiresAt: playbookStepRuns.expiresAt,
      inputInline: playbookStepRuns.inputInline,
      initiatorUserId: playbookRuns.initiatorUserId,
    })
    .from(playbookStepRuns)
    .innerJoin(playbookRuns, eq(playbookStepRuns.runId, playbookRuns.id))
    .where(eq(playbookStepRuns.id, input.stepRunId))
    .limit(1);

  if (!row) {
    throw new FeedbackNotPermittedError(`No feedback review with step run id ${input.stepRunId}.`);
  }
  if (input.runId && row.runId !== input.runId) {
    throw new FeedbackNotPermittedError(
      `No feedback review with step run id ${input.stepRunId} on run ${input.runId}.`
    );
  }
  if (row.stepType !== STEP_TYPE) {
    throw new FeedbackNotPermittedError(
      `Step run ${input.stepRunId} is a ${row.stepType} step, not a feedback review.`
    );
  }
  if (row.initiatorUserId !== input.deciderUserId) {
    throw new FeedbackNotPermittedError(
      'Only the person who started this run may review its AI outcomes.'
    );
  }
  if (row.status !== 'suspended') {
    if (row.status === 'completed' || row.status === 'expired') return { outcome: 'already-decided' };
    throw new FeedbackNotAwaitingError(input.stepRunId, row.status);
  }
  if (!row.expiresAt) throw new FeedbackMissingDeadlineError(input.stepRunId);

  const config = parseStepInput<FeedbackReviewStepConfig>(STEP_TYPE, row.inputInline ?? {});
  const steps = await db
    .select({
      stepId: playbookStepRuns.stepId,
      status: playbookStepRuns.status,
      outputInline: playbookStepRuns.outputInline,
    })
    .from(playbookStepRuns)
    .where(eq(playbookStepRuns.runId, row.runId))
    .limit(50);

  const sources = config.sourceStepIds.map((stepId) => {
    const source = steps.find((step) => step.stepId === stepId && step.status === 'completed');
    if (!source) {
      throw new FeedbackInvalidItemsError(
        `AI step "${stepId}" has not finished, so it cannot be reviewed yet.`
      );
    }
    return { stepId, output: source.outputInline };
  });
  const prompts = promptsForSources(sources);
  const items = cleanItems(input.items);
  if (!items) {
    throw new FeedbackInvalidItemsError(
      'Each question, override, and rejection needs a note, and every choice must be a known action.'
    );
  }
  const expected = new Set(prompts.map((prompt) => feedbackItemKey(prompt)));
  const received = new Set(items.map((item) => feedbackItemKey(item)));
  if (expected.size !== received.size || [...expected].some((key) => !received.has(key))) {
    throw new FeedbackInvalidItemsError('Choose what to do with each item from the selected AI steps.');
  }

  const decision = feedbackDecision({ stopped: input.stopped, items });
  const comment = input.comment?.trim().slice(0, 2000);
  const output = parseStepOutput(STEP_TYPE, {
    decision,
    decidedBy: input.deciderUserId,
    ...(comment ? { comment } : {}),
    items,
    revisionBrief: revisionBrief({ decision, items, prompts }),
  });
  const moved = await resumeStepRun({ stepRunId: input.stepRunId, output });
  return moved
    ? { outcome: 'recorded', decision, stepId: row.stepId }
    : { outcome: 'already-decided' };
}
