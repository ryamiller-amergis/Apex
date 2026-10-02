/**
 * Terminal result publishing. A worker must publish exactly one terminal
 * result before it exits, including when execution fails.
 */
import { randomUUID } from 'node:crypto';
import {
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunArtifactStatus,
  type AiRunBlobRef,
  type AiRunV2FailureCategory,
  type AiRunV2TerminalAttemptStatus,
  type AiRunV2TerminalResult,
} from '../../../shared/types/aiRunV2';

export type ResultTarget = Readonly<{
  runId: string;
  attemptId: string;
  attemptNumber: number;
  dispatchMessageId: string;
}>;

export type ResultSender = (
  messageId: string,
  body: AiRunV2TerminalResult,
) => Promise<void>;

export type PublishTerminalInput = Readonly<{
  status: AiRunV2TerminalAttemptStatus;
  artifactStatus: AiRunArtifactStatus;
  failureCategory?: AiRunV2FailureCategory;
  detail?: string;
  manifestRef?: AiRunBlobRef;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}>;

export type ResultPublisher = {
  publishTerminal(input: PublishTerminalInput): Promise<void>;
  hasPublished(): boolean;
};

export function createResultPublisher(deps: {
  target: ResultTarget;
  send: ResultSender;
  now?: () => Date;
  newEventId?: () => string;
}): ResultPublisher {
  const now = deps.now ?? (() => new Date());
  const newEventId = deps.newEventId ?? randomUUID;
  let published = false;
  let attempted: AiRunV2TerminalResult | null = null;

  return {
    async publishTerminal(input) {
      // A second terminal for the same attempt would race the orchestrator's
      // fenced finalize, so the first one wins here too.
      if (published) return;
      // A send that threw may still have reached Service Bus, so a retry
      // resends the same message id for duplicate detection to collapse.
      if (attempted) {
        await deps.send(attempted.eventId, attempted);
        published = true;
        return;
      }
      const result: AiRunV2TerminalResult = {
        schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
        eventId: newEventId(),
        runId: deps.target.runId,
        attemptId: deps.target.attemptId,
        attemptNumber: deps.target.attemptNumber,
        dispatchMessageId: deps.target.dispatchMessageId,
        timestamp: now().toISOString(),
        kind: 'terminal',
        status: input.status,
        artifactStatus: input.artifactStatus,
        ...(input.failureCategory === undefined
          ? {}
          : { failureCategory: input.failureCategory }),
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        ...(input.manifestRef === undefined
          ? {}
          : { manifestRef: input.manifestRef }),
        ...(input.durationMs === undefined
          ? {}
          : { durationMs: input.durationMs }),
        ...(input.inputTokens === undefined
          ? {}
          : { inputTokens: input.inputTokens }),
        ...(input.outputTokens === undefined
          ? {}
          : { outputTokens: input.outputTokens }),
        ...(input.cacheReadTokens === undefined
          ? {}
          : { cacheReadTokens: input.cacheReadTokens }),
        ...(input.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: input.cacheWriteTokens }),
      };
      attempted = result;
      await deps.send(result.eventId, result);
      published = true;
    },

    hasPublished() {
      return published;
    },
  };
}
