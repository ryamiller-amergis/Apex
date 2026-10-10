/**
 * Everything that must happen once an agent run's terminal write is durable,
 * shared by both transports.
 *
 * Neither transport's write moves. V1 writes through the completion handler in
 * `pgNotifyService`, which CASes the run header, persists the terminal events,
 * and idles the owning thread in one transaction. V2 writes through
 * `transitionAttempt` in `aiRunV2/runAttemptRepository`, which finalizes the
 * attempt row and its run header in one transaction — a crash between those
 * two rows must not leave a finalized attempt sitting on a running run. What
 * the transports share is what follows, and it lives here so a run that
 * finished on V2 is observed exactly like one that finished on V1.
 *
 * Admission slot release is deliberately not here. It publishes V1 dispatch
 * messages, and V2 capacity is governed by the orchestrator's own utilization
 * reader, so `markTerminal` keeps that call.
 *
 * Nothing in here throws. The run is already terminal by the time it runs, and
 * the V2 caller acknowledges a Service Bus message straight afterwards.
 */
import { randomUUID } from 'crypto';
import type {
  AgentRunLane,
  AgentRunStatus,
  AgentRunTerminalReason,
} from '../../shared/types/agentRunLifecycle';
import type { AgentRunEventEnvelope } from '../../shared/types/chat';
import {
  nextRunEventSequence,
  notifyRunEvent,
  RUN_EVENT_SOURCE_INSTANCE,
} from './pgNotifyService';
import { workerTierTelemetry } from './workerTierTelemetry';

export type TerminalGroundingDeactivator = (
  threadId: string,
  projectId: string,
) => Promise<void>;

export type PublishRunEvent = (
  event: AgentRunEventEnvelope,
  options: { persist: boolean },
) => Promise<void>;

/** The run header as the terminal write left it. */
export type TerminalRunSubject = Readonly<{
  runId: string;
  threadId: string;
  projectId: string | null;
  lane: AgentRunLane | null;
  status: Extract<AgentRunStatus, 'completed' | 'failed' | 'cancelled'>;
  /** Status the header held before the terminal write. */
  fromStatus: AgentRunStatus;
  terminalReason: AgentRunTerminalReason | null;
  dispatchMessageId: string | null;
}>;

export type ApplyTerminalRunEffectsInput = Readonly<{
  run: TerminalRunSubject;
  detail?: string;
  /**
   * True when the caller's own terminal transaction already persisted and
   * fanned out the run's terminal events, as V1's completion handler does. The
   * V2 attempt transaction writes only the run header, so this module owns the
   * terminal event for it.
   */
  terminalEventsPersisted: boolean;
  deactivateGrounding?: TerminalGroundingDeactivator;
  publishRunEvent?: PublishRunEvent;
}>;

function telemetryContext(run: TerminalRunSubject): {
  runId: string;
  project?: string;
  lane?: string;
  dispatchMessageId?: string;
} {
  return {
    runId: run.runId,
    ...(run.projectId ? { project: run.projectId } : {}),
    ...(run.lane ? { lane: run.lane } : {}),
    ...(run.dispatchMessageId
      ? { dispatchMessageId: run.dispatchMessageId }
      : {}),
  };
}

function emitWorkerTelemetry(emit: () => void): void {
  try {
    emit();
  } catch {
    // Telemetry must never affect lifecycle durability.
  }
}

/**
 * Grounding stays behind a lazy import so the module's git and repo-cache
 * graph is not pulled into every process that can terminalize a run — the V2
 * orchestrator only needs it when a run actually finishes.
 */
export async function deactivateTerminalGrounding(
  threadId: string,
  projectId: string,
): Promise<void> {
  const { runGroundingService } = await import('./runGroundingService');
  await runGroundingService.persistThenMarkTerminalInactive(
    { runType: 'chat', runId: threadId, project: projectId },
    async () => undefined,
  );
}

export async function bestEffortDeactivateGrounding(
  run: {
    id: string;
    threadId: string;
    projectId: string | null;
    lane: AgentRunLane | null;
    status: string;
  },
  deactivate: TerminalGroundingDeactivator,
): Promise<void> {
  if (run.lane !== 'background' || !run.projectId) return;
  try {
    await deactivate(run.threadId, run.projectId);
  } catch {
    console.error('[agent-run-lifecycle]', JSON.stringify({
      runId: run.id,
      projectId: run.projectId,
      lane: run.lane,
      status: run.status,
      reason: 'grounding_deactivation_failed',
    }));
  }
}

function buildTerminalDoneEvent(
  run: TerminalRunSubject,
  detail: string | undefined,
  timestamp: string,
): AgentRunEventEnvelope {
  return {
    eventId: randomUUID(),
    threadId: run.threadId,
    runId: run.runId,
    sourceInstance: RUN_EVENT_SOURCE_INSTANCE,
    sequence: nextRunEventSequence(run.runId),
    timestamp,
    type: 'done',
    phase: 'completion',
    status: run.status,
    detail,
    event: { type: 'done', runId: run.runId },
  };
}

/**
 * Apply the post-terminal effects for a run whichever transport wrote it.
 */
export async function applyTerminalRunEffects(
  input: ApplyTerminalRunEffectsInput,
): Promise<void> {
  const { run } = input;

  if (!input.terminalEventsPersisted) {
    const publish = input.publishRunEvent ?? notifyRunEvent;
    try {
      await publish(
        buildTerminalDoneEvent(run, input.detail, new Date().toISOString()),
        { persist: true },
      );
    } catch {
      // The run is already terminal. A lost event is recoverable from the run
      // header; failing here would strand the caller's terminal message.
      console.error('[agent-run-lifecycle]', JSON.stringify({
        runId: run.runId,
        lane: run.lane,
        status: run.status,
        reason: 'terminal_event_publish_failed',
      }));
    }
  }

  await bestEffortDeactivateGrounding(
    {
      id: run.runId,
      threadId: run.threadId,
      projectId: run.projectId,
      lane: run.lane,
      status: run.status,
    },
    input.deactivateGrounding ?? deactivateTerminalGrounding,
  );

  // Never log snapshot / prompt / workspace content (PBI-001 security NFR).
  console.info('[agent-run-lifecycle]', JSON.stringify({
    runId: run.runId,
    projectId: run.projectId,
    lane: run.lane,
    fromStatus: run.fromStatus,
    toStatus: run.status,
    dispatchMessageId: run.dispatchMessageId,
    terminalReason: run.terminalReason,
  }));

  if (run.lane === 'background') {
    emitWorkerTelemetry(() => {
      workerTierTelemetry.terminalReason(
        telemetryContext(run),
        run.terminalReason ?? run.status,
      );
    });
  }
}
