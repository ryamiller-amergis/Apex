/**
 * Stores one outcome-level learning record for a Playbook step.
 *
 * The record links earlier AI steps to a completed human review. It keeps the decision, the
 * overall comment, structured answers, and enough provenance to compare a later run. It does not
 * keep prompts, reports, or chain-of-thought, and it does not change a skill.
 */
import { eq } from 'drizzle-orm';
import type {
  PlaybookOutcomeFeedbackAnswer,
  PlaybookOutcomeFeedbackSource,
} from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import {
  playbookOutcomeFeedback,
  playbookRuns,
  playbookStepRuns,
} from '../db/schema';
import {
  isAgentStepType,
  isApprovalGateStepType,
  isFeedbackReviewStepType,
  isHumanReviewStepType,
} from './playbookSteps/registry';

export class PlaybookOutcomeFeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookOutcomeFeedbackError';
  }
}

export interface CapturePlaybookOutcomeFeedbackInput {
  runId: string;
  captureStepRunId: string;
  sourceStepIds: string[];
  reviewStepId?: string;
  feedbackStepId?: string;
  label?: string;
}

export type PlaybookOutcomeDecision =
  | 'approved'
  | 'rejected'
  | 'needs_changes'
  | 'recorded';

export interface CapturedPlaybookOutcome {
  feedbackId: string;
  decision: PlaybookOutcomeDecision;
  sourceCount: number;
  capturedAt: string;
}

interface StoredOutcome {
  id: string;
  decision: PlaybookOutcomeDecision;
  sources: PlaybookOutcomeFeedbackSource[];
  capturedAt: string;
}

function textOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function feedbackItems(value: unknown): PlaybookOutcomeFeedbackAnswer[] {
  if (!Array.isArray(value)) return [];
  const answers: PlaybookOutcomeFeedbackAnswer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const sourceStepId = textOrNull(source.sourceStepId, 80);
    const itemId = textOrNull(source.itemId, 80);
    const resolution = textOrNull(source.action, 80);
    const response = textOrNull(source.note, 2000) ?? resolution;
    if (!sourceStepId || !itemId || !resolution || !response) continue;
    answers.push({
      decisionId: `${sourceStepId}:${itemId}`.slice(0, 80),
      resolution,
      response,
    });
    if (answers.length === 20) break;
  }
  return answers;
}

function reviewDecision(
  stepType: string,
  output: Record<string, unknown>
): PlaybookOutcomeDecision | null {
  const decision = output.decision;
  if (isApprovalGateStepType(stepType)) {
    return decision === 'approved' || decision === 'rejected' ? decision : null;
  }
  if (isFeedbackReviewStepType(stepType)) {
    if (decision === 'accepted') return 'approved';
    if (decision === 'needs_changes') return 'needs_changes';
    if (decision === 'rejected') return 'rejected';
  }
  return null;
}

function structuredAnswers(value: unknown): PlaybookOutcomeFeedbackAnswer[] {
  if (!Array.isArray(value)) return [];
  const answers: PlaybookOutcomeFeedbackAnswer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const decisionId = textOrNull(source.decisionId, 80);
    const resolution = textOrNull(source.resolution, 80);
    const response = textOrNull(source.response, 2000);
    if (!decisionId || !resolution || !response) continue;
    answers.push({ decisionId, resolution, response });
    if (answers.length === 20) break;
  }
  return answers;
}

function provenance(row: {
  id: string;
  stepId: string;
  stepType: string;
  agentRunId: string | null;
  inputInline: Record<string, unknown> | null;
}): PlaybookOutcomeFeedbackSource {
  const input = row.inputInline ?? {};
  return {
    stepId: row.stepId,
    stepRunId: row.id,
    stepType: row.stepType,
    agentRunId: row.agentRunId,
    skillPath: textOrNull(input.skillPath, 300),
    model: textOrNull(input.model, 120),
  };
}

function toResult(row: StoredOutcome): CapturedPlaybookOutcome {
  return {
    feedbackId: row.id,
    decision: row.decision,
    sourceCount: row.sources.length,
    capturedAt: row.capturedAt,
  };
}

async function findCaptured(
  captureStepRunId: string
): Promise<StoredOutcome | null> {
  const [row] = await db
    .select({
      id: playbookOutcomeFeedback.id,
      decision: playbookOutcomeFeedback.decision,
      sources: playbookOutcomeFeedback.sources,
      capturedAt: playbookOutcomeFeedback.capturedAt,
    })
    .from(playbookOutcomeFeedback)
    .where(eq(playbookOutcomeFeedback.captureStepRunId, captureStepRunId))
    .limit(1);
  return row ?? null;
}

export async function capturePlaybookOutcomeFeedback(
  input: CapturePlaybookOutcomeFeedbackInput
): Promise<CapturedPlaybookOutcome> {
  const existing = await findCaptured(input.captureStepRunId);
  if (existing) return toResult(existing);

  const [run] = await db
    .select({ definitionVersionId: playbookRuns.definitionVersionId })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, input.runId))
    .limit(1);
  if (!run) {
    throw new PlaybookOutcomeFeedbackError(
      `Playbook run ${input.runId} was not found.`
    );
  }

  const steps = await db
    .select({
      id: playbookStepRuns.id,
      stepId: playbookStepRuns.stepId,
      stepType: playbookStepRuns.stepType,
      status: playbookStepRuns.status,
      agentRunId: playbookStepRuns.agentRunId,
      inputInline: playbookStepRuns.inputInline,
      outputInline: playbookStepRuns.outputInline,
    })
    .from(playbookStepRuns)
    .where(eq(playbookStepRuns.runId, input.runId))
    .limit(50);

  const review = input.reviewStepId
    ? steps.find((step) => step.stepId === input.reviewStepId)
    : undefined;
  const reviewOutput = (review?.outputInline ?? {}) as Record<string, unknown>;
  const decision = review
    ? reviewDecision(review.stepType, reviewOutput)
    : 'recorded';
  if (
    input.reviewStepId &&
    (!review ||
      review.status !== 'completed' ||
      !isHumanReviewStepType(review.stepType) ||
      !decision)
  ) {
    throw new PlaybookOutcomeFeedbackError(
      `Review step "${input.reviewStepId}" has no completed decision to learn from.`
    );
  }

  const feedback = input.feedbackStepId
    ? steps.find((step) => step.stepId === input.feedbackStepId)
    : undefined;
  if (
    input.feedbackStepId &&
    (!feedback ||
      feedback.status !== 'completed' ||
      !isFeedbackReviewStepType(feedback.stepType))
  ) {
    throw new PlaybookOutcomeFeedbackError(
      `Feedback review "${input.feedbackStepId}" has no completed choices to learn from.`
    );
  }

  const sources = input.sourceStepIds.flatMap((stepId) => {
    const source = steps.find((step) => step.stepId === stepId);
    if (!source || source.status !== 'completed' || !isAgentStepType(source.stepType)) {
      return [];
    }
    return [provenance(source)];
  });
  if (sources.length === 0) {
    throw new PlaybookOutcomeFeedbackError(
      'None of the selected AI steps have a completed result to learn from.'
    );
  }

  const answers = [
    ...structuredAnswers(reviewOutput.answers),
    ...feedbackItems(
      feedback && feedback.id !== review?.id
        ? (feedback.outputInline as Record<string, unknown> | null)?.items
        : review && isFeedbackReviewStepType(review.stepType)
          ? reviewOutput.items
          : []
    ),
  ].slice(0, 20);
  const capturedAt = new Date().toISOString();
  const [inserted] = await db
    .insert(playbookOutcomeFeedback)
    .values({
      runId: input.runId,
      captureStepRunId: input.captureStepRunId,
      reviewStepRunId: review?.id ?? null,
      definitionVersionId: run.definitionVersionId,
      label: textOrNull(input.label, 120),
      decision: decision ?? 'recorded',
      overallComment: textOrNull(reviewOutput.comment, 2000),
      answers,
      sources,
      capturedAt,
    })
    .onConflictDoNothing({ target: playbookOutcomeFeedback.captureStepRunId })
    .returning({
      id: playbookOutcomeFeedback.id,
      decision: playbookOutcomeFeedback.decision,
      sources: playbookOutcomeFeedback.sources,
      capturedAt: playbookOutcomeFeedback.capturedAt,
    });

  const stored = inserted ?? (await findCaptured(input.captureStepRunId));
  if (!stored) {
    throw new PlaybookOutcomeFeedbackError(
      `Outcome feedback for step run ${input.captureStepRunId} could not be stored.`
    );
  }
  return toResult(stored);
}
