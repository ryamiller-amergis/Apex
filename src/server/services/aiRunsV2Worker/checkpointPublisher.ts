/**
 * Checkpoint publishing for a single attempt.
 *
 * The started checkpoint carries the Container Apps execution id, which is the
 * only handle the reconciler can probe when heartbeats stop.
 */
import { randomUUID } from 'node:crypto';
import {
  AI_RUN_V2_MAX_PROGRESS_TEXT_BYTES,
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunV2ActivityEventProgress,
  type AiRunV2Checkpoint,
  type AiRunV2RunProgress,
} from '../../../shared/types/aiRunV2';
import type { AgentRunEventEnvelope } from '../../../shared/types/chat';

export const CHECKPOINT_INTERVAL_MS = 30_000;

/** Room the envelope's own fields need inside the message bound. */
const ACTIVITY_EVENT_BUDGET_BYTES = AI_RUN_V2_MAX_PROGRESS_TEXT_BYTES - 2_048;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * A long reply or thinking block would push the checkpoint past the bound the
 * consumer validates, which drops the whole message. Keep the event's shape and
 * truncate its text instead, so the step log still gets the entry.
 */
function boundActivityEvent(
  progress: AiRunV2ActivityEventProgress,
): AiRunV2ActivityEventProgress {
  if (byteLength(JSON.stringify(progress)) <= ACTIVITY_EVENT_BUDGET_BYTES) {
    return progress;
  }
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(progress.event)) {
    trimmed[key] = typeof value === 'string' && byteLength(value) > 2_048
      ? `${value.slice(0, 2_000)}…`
      : value;
  }
  const bounded = { ...progress, event: trimmed };
  if (byteLength(JSON.stringify(bounded)) <= ACTIVITY_EVENT_BUDGET_BYTES) {
    return bounded;
  }
  // Still over budget: keep only what the log reads to label the entry.
  return {
    ...progress,
    event: {
      type: progress.eventType,
      ...(typeof trimmed.toolName === 'string' ? { toolName: trimmed.toolName } : {}),
    },
  };
}

export type CheckpointTarget = Readonly<{
  runId: string;
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
}>;

export type CheckpointSender = (
  messageId: string,
  body: AiRunV2Checkpoint,
) => Promise<void>;

export type CheckpointPublisherDeps = Readonly<{
  target: CheckpointTarget;
  send: CheckpointSender;
  now?: () => Date;
  newEventId?: () => string;
}>;

export type CheckpointPublisher = {
  /** Sequence numbers start at 1 and never repeat for an attempt. */
  publishStarted(containerAppsExecutionId: string): Promise<void>;
  publishHeartbeat(): Promise<void>;
  publishProgress(
    phase: string,
    status: string,
    detail?: string,
    progress?: AiRunV2RunProgress,
  ): Promise<void>;
  /** Persist one summarized Cursor event for replay in the Playbook step log. */
  publishActivity?(event: AgentRunEventEnvelope): Promise<void>;
  lastSequence(): number;
};

export function createCheckpointPublisher(
  deps: CheckpointPublisherDeps,
): CheckpointPublisher {
  const now = deps.now ?? (() => new Date());
  const newEventId = deps.newEventId ?? randomUUID;
  let sequence = 0;
  let sendChain: Promise<void> = Promise.resolve();

  function envelope(): Omit<AiRunV2Checkpoint, 'kind' | 'checkpointSequence'> {
    return {
      schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
      eventId: newEventId(),
      runId: deps.target.runId,
      attemptId: deps.target.attemptId,
      attemptNumber: deps.target.attemptNumber,
      dispatchMessageId: deps.target.dispatchMessageId,
      timestamp: now().toISOString(),
    };
  }

  async function publish(checkpoint: AiRunV2Checkpoint): Promise<void> {
    const current = sendChain.then(() =>
      deps.send(checkpoint.eventId, checkpoint));
    sendChain = current.catch(() => undefined);
    await current;
  }

  return {
    async publishStarted(containerAppsExecutionId) {
      sequence += 1;
      await publish({
        ...envelope(),
        kind: 'started',
        checkpointSequence: sequence,
        containerAppsExecutionId,
      });
    },

    async publishHeartbeat() {
      sequence += 1;
      await publish({
        ...envelope(),
        kind: 'heartbeat',
        checkpointSequence: sequence,
      });
    },

    async publishProgress(phase, status, detail, progress) {
      sequence += 1;
      await publish({
        ...envelope(),
        kind: 'progress',
        checkpointSequence: sequence,
        phase,
        status,
        ...(detail === undefined ? {} : { detail }),
        ...(progress === undefined ? {} : { progress }),
      });
    },

    async publishActivity(event) {
      sequence += 1;
      await publish({
        ...envelope(),
        kind: 'progress',
        checkpointSequence: sequence,
        phase: event.phase,
        status: event.status,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
        progress: boundActivityEvent({
          kind: 'activity_event',
          eventType: event.type,
          phase: event.phase,
          status: event.status,
          ...(event.detail === undefined ? {} : { detail: event.detail }),
          event: event.event as unknown as Record<string, unknown>,
        }),
      });
    },

    lastSequence() {
      return sequence;
    },
  };
}
