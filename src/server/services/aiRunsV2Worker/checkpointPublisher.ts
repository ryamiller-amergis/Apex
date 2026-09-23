/**
 * Checkpoint publishing for a single attempt.
 *
 * The started checkpoint carries the Container Apps execution id, which is the
 * only handle the reconciler can probe when heartbeats stop.
 */
import { randomUUID } from 'node:crypto';
import {
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunV2Checkpoint,
  type AiRunV2RunProgress,
} from '../../../shared/types/aiRunV2';

export const CHECKPOINT_INTERVAL_MS = 30_000;

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

    lastSequence() {
      return sequence;
    },
  };
}
