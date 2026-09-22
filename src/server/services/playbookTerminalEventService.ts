/**
 * TBI-020 — the latency path.
 *
 * When an agent run finishes, the Playbook step waiting on it should move within seconds rather
 * than within a sweep interval. This subscribes to terminal agent-run events and resumes the
 * correlated step immediately.
 *
 * It is explicitly allowed to miss events, which is why `playbookReconciliationService` exists. A
 * NOTIFY is not durable: an instance restarting between the agent run finishing and the event
 * arriving loses it, and nothing replays it. Treating this path as best-effort is what lets it stay
 * simple — no acknowledgement, no retry, no dead-letter. The sweep is the guarantee.
 *
 * The failure case is the one worth stating. A terminal event carries an outcome, and a step whose
 * agent run *failed* must fail rather than resume as though the work happened. Reading the status
 * off the envelope rather than assuming success is the difference between a Playbook that reports
 * what occurred and one that reports that it ran.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { playbookStepRuns } from '../db/schema';
import { subscribeAllRunEvents } from './pgNotifyService';
import { advanceRun } from './playbookAdvanceService';
import { parseStepOutput } from './playbookSteps/descriptorValidation';
import { failStepRun, resumeStepRun } from './playbookSteps/stepRuns';
import type { AgentRunEventEnvelope, AgentRunEventStatus } from '../../shared/types/chat';

/** The three outcomes that end an agent run. Anything else is progress, not a conclusion. */
const TERMINAL_EVENT_STATUSES: ReadonlySet<AgentRunEventStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export type TerminalEventOutcome =
  /** The correlated step moved. */
  | { handled: 'resumed'; stepRunId: string }
  /** The correlated step failed, because the agent run did. */
  | { handled: 'failed'; stepRunId: string }
  /** A step was found but had already moved — a duplicate delivery, which is ordinary. */
  | { handled: 'already-moved'; stepRunId: string }
  /** No Playbook step is waiting on this agent run. Most events are this: ordinary chat traffic. */
  | { handled: 'not-correlated' };

export function isTerminalRunEvent(event: AgentRunEventEnvelope): boolean {
  return TERMINAL_EVENT_STATUSES.has(event.status);
}

/**
 * Moves the step correlated with a finished agent run.
 *
 * Idempotence is the conditional update inside `resumeStepRun`, not a check here. A second
 * delivery matches zero rows because the status is no longer `suspended`, and is reported as
 * already-moved. Reading the row first and then writing would leave a window in which two
 * deliveries both see `suspended` and both advance the run.
 */
export async function handleTerminalAgentRunEvent(
  event: AgentRunEventEnvelope
): Promise<TerminalEventOutcome> {
  if (!isTerminalRunEvent(event)) return { handled: 'not-correlated' };

  const [step] = await db
    .select({
      id: playbookStepRuns.id,
      runId: playbookStepRuns.runId,
      // The graph node, not the row: it is what the engine is parked at and how it is told to go on.
      stepId: playbookStepRuns.stepId,
      stepType: playbookStepRuns.stepType,
      status: playbookStepRuns.status,
    })
    .from(playbookStepRuns)
    .where(eq(playbookStepRuns.agentRunId, event.runId))
    .limit(1);

  if (!step) return { handled: 'not-correlated' };

  if (event.status === 'completed') {
    const output = parseStepOutput(step.stepType, {
      agentRunId: event.runId,
      completedAt: event.timestamp,
    });
    const moved = await resumeStepRun({
      stepRunId: step.id,
      // DoD-2: the next step must be able to read what this one produced.
      output,
    });

    if (!moved) return { handled: 'already-moved', stepRunId: step.id };

    /*
     * Resuming the step is only half of it: without this the run sits at `running` with nothing
     * left to wake it, because the event that would have advanced it has just been consumed. Only
     * the delivery that actually moved the step advances, so a redelivery cannot start the next
     * step twice — though `advanceRun` would refuse that anyway.
     */
    await advanceRun(step.runId, step.stepId);

    return { handled: 'resumed', stepRunId: step.id };
  }

  /*
   * Failed or cancelled. Marked retryable because the agent turn is what failed, not the Playbook:
   * Cursor work cannot resume mid-turn, so a person decides whether to run it again. That is the
   * same status FEAT-003 shipped for process death mid-step, and deliberately so — both are "this
   * step did not finish and nobody can tell it to carry on from where it stopped".
   */
  if (step.status !== 'suspended') {
    return { handled: 'already-moved', stepRunId: step.id };
  }

  await failStepRun({
    stepRunId: step.id,
    retryable: true,
    reason: `Agent run ${event.runId} ended as ${event.status}.`,
  });

  return { handled: 'failed', stepRunId: step.id };
}

let unsubscribe: (() => void) | null = null;

/**
 * Registers the subscription. Called once at startup, after the flag check.
 *
 * Errors are swallowed with a log rather than propagated: this is a best-effort path, and an
 * exception escaping into `pgNotifyService`'s dispatch loop would break event delivery for every
 * other subscriber, including the chat streams a person is watching.
 */
export function startPlaybookTerminalEventListener(): void {
  if (unsubscribe) return;

  unsubscribe = subscribeAllRunEvents((event) => {
    if (!isTerminalRunEvent(event)) return;

    void handleTerminalAgentRunEvent(event).catch((error: Error) => {
      console.error(
        `[playbook] terminal event for agent run ${event.runId} failed to resume its step:`,
        error.message
      );
    });
  });
}

export function stopPlaybookTerminalEventListener(): void {
  unsubscribe?.();
  unsubscribe = null;
}
