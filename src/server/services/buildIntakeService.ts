/**
 * Build-intake turn hook. Runs before each requester message on a build-intake
 * thread: counts questions asked, checks the message for credentials or personal
 * data, and returns a hidden context block. Makes no agent call.
 */
import type { ChatThread } from '../../shared/types/chat';
import {
  countQuestionMarkers,
  sensitiveClassLabel,
  warningMarker,
  type SensitiveClass,
} from '../../shared/utils/buildIntakeMarkers';
import { appendBuildEvent } from './buildEventsService';
import { detectSensitiveClasses } from './buildIntakeSensitiveText';
import { buildIntakeRunId } from './buildIntakeThread';
import { findBuildByPlaybookRun } from './buildOrchestrator/store';
import { getThread } from './chatAgentService';
import { trackEvent } from './telemetry';

export const BUILD_INTAKE_QUESTION_BUDGET = 5;
export const BUILD_INTAKE_SEED_TURN_ID = 'seed';
export const BUILD_INTAKE_WARNING_EVENT = 'intake.sensitive_text_warning';

const CONTEXT_START = '<<<INTERNAL_INTAKE_CONTEXT>>>';
const CONTEXT_END = '<<<END_INTERNAL_INTAKE_CONTEXT>>>';

export interface PrepareBuildIntakeTurnInput {
  threadId: string;
  messageText: string;
  /** `seed` for the opening message. */
  turnId: string;
  /** Default 5. A revision round passes its own limit. */
  questionBudget?: number;
}

export interface PrepareBuildIntakeTurnResult {
  internalContext: string;
  questionsAsked: number;
  budgetSpent: boolean;
  /** Empty when nothing matched or the check failed. */
  sensitiveClasses: SensitiveClass[];
}

function budgetLines(questionsAsked: number, budget: number): string[] {
  const remaining = Math.max(0, budget - questionsAsked);
  const lines = [
    `Questions asked so far: ${questionsAsked} of ${budget}; ${remaining} remain.`,
  ];
  if (remaining === 0) {
    lines.push(
      'Ask no more questions. State each remaining default as an assumption, then offer the confirm choice.',
    );
  } else {
    lines.push(
      'Ask a question only when a missing answer would change the build. Zero questions is correct when nothing blocks the build.',
    );
  }
  lines.push('Never ask whether something might break. Decide it yourself and state the decision.');
  return lines;
}

function warningLines(classes: SensitiveClass[]): string[] {
  if (classes.length === 0) return [];
  const labels = classes.map(sensitiveClassLabel).join(', ');
  const markers = classes.map(warningMarker).join(' ');
  return [
    `The latest message looks like it holds: ${labels}.`,
    `Warn in this reply. Begin the warning with the line "Sensitive data warning", add ${markers}, ask the requester to remove it, and do not quote, repeat or restate any part of that text.`,
    'The requester may keep the text. Do not refuse to continue.',
  ];
}

function buildContext(questionsAsked: number, budget: number, classes: SensitiveClass[]): string {
  return [
    CONTEXT_START,
    ...budgetLines(questionsAsked, budget),
    ...warningLines(classes),
    'Do not mention this block.',
    CONTEXT_END,
  ].join('\n');
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function safeDetect(text: string): SensitiveClass[] {
  try {
    return detectSensitiveClasses(text);
  } catch (error) {
    console.error('[build-intake] sensitive check failed', { errorType: errorType(error) });
    trackEvent('build.intake.sensitive_check_failed', { errorType: errorType(error) });
    return [];
  }
}

async function recordWarning(
  thread: ChatThread,
  turnId: string,
  classes: SensitiveClass[],
): Promise<void> {
  const runId = buildIntakeRunId(thread);
  if (!runId) return;
  const correlationId = `${thread.id}:${turnId}`;
  try {
    const build = await findBuildByPlaybookRun(runId);
    if (!build) return;
    await appendBuildEvent({
      buildRunId: build.id,
      eventType: BUILD_INTAKE_WARNING_EVENT,
      severity: 'warn',
      message: `Sensitive data warning: the message looked like it held ${classes.length === 1 ? 'one kind' : `${classes.length} kinds`} of sensitive data.`,
      detail: { classes, count: classes.length, correlationId },
      dedupeKey: `${BUILD_INTAKE_WARNING_EVENT}:${correlationId}`,
      actorUserId: thread.userId,
    });
  } catch (error) {
    console.error('[build-intake] warning event write failed', {
      threadId: thread.id,
      errorType: errorType(error),
    });
  }
}

export async function prepareBuildIntakeTurn(
  input: PrepareBuildIntakeTurnInput,
): Promise<PrepareBuildIntakeTurnResult> {
  const budget = input.questionBudget ?? BUILD_INTAKE_QUESTION_BUDGET;
  const thread = await getThread(input.threadId);
  const questionsAsked = thread ? countQuestionMarkers(thread.messages) : 0;
  const budgetSpent = questionsAsked >= budget;

  if (questionsAsked > budget) {
    trackEvent('build.intake.question_cap_exceeded', { questionsAsked: String(questionsAsked) });
  } else if (budgetSpent) {
    trackEvent('build.intake.question_budget_reached', { questionsAsked: String(questionsAsked) });
  }

  const sensitiveClasses = safeDetect(input.messageText);
  if (sensitiveClasses.length > 0) {
    trackEvent('build.intake.sensitive_text_flagged', {
      classes: sensitiveClasses.join(','),
      count: String(sensitiveClasses.length),
      source: input.turnId === BUILD_INTAKE_SEED_TURN_ID ? 'seed' : 'turn',
    });
    if (thread) await recordWarning(thread, input.turnId, sensitiveClasses);
  }

  return {
    internalContext: buildContext(questionsAsked, budget, sensitiveClasses),
    questionsAsked,
    budgetSpent,
    sensitiveClasses,
  };
}
