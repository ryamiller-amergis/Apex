/**
 * Shared V2 worker run loop for the document and visual lanes.
 *
 * Ordering rules this enforces:
 *  - the started checkpoint goes out before the command is completed, so a
 *    crash between the two redelivers rather than stranding the attempt;
 *  - heartbeats continue for the whole execution;
 *  - artifacts upload before the manifest, and the manifest before the result;
 *  - exactly one terminal result is published, including on failure.
 *
 * Nothing here touches PostgreSQL: the worker's only state is the queue, the
 * blob container, and its own process.
 */
import {
  isAiRunV2Command,
  type AiRunBlobRef,
  type AiRunV2Command,
  type AiRunV2FailureCategory,
} from '../../../shared/types/aiRunV2';
import {
  createArtifactUploader,
  type ArtifactFile,
} from './artifactUploader';
import {
  CHECKPOINT_INTERVAL_MS,
  createCheckpointPublisher,
  type CheckpointPublisher,
} from './checkpointPublisher';
import { createResultPublisher } from './resultPublisher';
import {
  createSpecificationClient,
  type ExecutionSpecification,
  type SpecificationClient,
} from './specificationClient';
import type { WorkerServiceBusClient } from './serviceBusClient';
import {
  CursorExecutionWaitError,
  type CursorTokenUsage,
} from '../cursorExecutionCore';

/** Normal phase budget, and the longer budget for large workloads. */
export const NORMAL_PHASE_DEADLINE_MS = 15 * 60_000;
export const LARGE_PHASE_DEADLINE_MS = 45 * 60_000;

export type ExecutionOutcome = Readonly<{
  files: ReadonlyArray<ArtifactFile>;
  detail?: string;
  durationMs?: number;
  usage?: CursorTokenUsage;
}>;

export type ExecuteWorkload = (input: {
  specification: ExecutionSpecification;
  command: AiRunV2Command;
  checkpoints: CheckpointPublisher;
  signal: AbortSignal;
}) => Promise<ExecutionOutcome>;

export type WorkerDeps = Readonly<{
  bus: WorkerServiceBusClient;
  execute: ExecuteWorkload;
  artifactContainer: string;
  containerAppsExecutionId: string;
  specifications?: SpecificationClient;
  checkpointIntervalMs?: number;
  deadlineMs?: number;
  resolveCommandDeadlineMs?: (command: AiRunV2Command) => number;
  resolveDeadlineMs?: (specification: ExecutionSpecification) => number;
  maxDeliveryCount?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}>;

export type WorkerRunOutcome =
  | 'idle'
  | 'completed'
  | 'failed'
  | 'poison'
  | 'redeliver';

export type V2Worker = {
  processOnce(): Promise<WorkerRunOutcome>;
  runLoop(): Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureCategoryFor(error: unknown): AiRunV2FailureCategory {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'progress_timeout';
  }
  return 'internal_error';
}

function executionAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Execution deadline elapsed');
  error.name = 'AbortError';
  return error;
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw executionAbortError(signal);
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort(executionAbortError(signal));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function createV2Worker(deps: WorkerDeps): V2Worker {
  const specifications = deps.specifications ?? createSpecificationClient();
  const heartbeatMs = deps.checkpointIntervalMs ?? CHECKPOINT_INTERVAL_MS;
  const deadlineMs = deps.deadlineMs ?? NORMAL_PHASE_DEADLINE_MS;
  const maxDelivery = deps.maxDeliveryCount ?? 5;
  const sleep = deps.sleep ?? defaultSleep;

  async function processOnce(): Promise<WorkerRunOutcome> {
    const message = await deps.bus.receiveCommand();
    if (!message) return 'idle';

    if (!isAiRunV2Command(message.body)) {
      if (message.deliveryCount >= maxDelivery) {
        await deps.bus.deadLetterCommand(
          message.lockToken,
          'poison_message',
          'Command payload failed schema validation',
        );
        return 'poison';
      }
      await deps.bus.abandonCommand(message.lockToken);
      return 'redeliver';
    }

    const command = message.body;
    const target = {
      runId: command.runId,
      attemptId: command.attemptId,
      attemptNumber: command.attemptNumber,
      dispatchMessageId: command.dispatchMessageId,
    };
    const checkpoints = createCheckpointPublisher({
      target,
      send: (messageId, body) => deps.bus.sendCheckpoint(messageId, body),
    });
    const results = createResultPublisher({
      target,
      send: (messageId, body) => deps.bus.sendResult(messageId, body),
    });

    // Claim the attempt before completing the command: if this worker dies
    // now, the command is redelivered instead of silently disappearing.
    await checkpoints.publishStarted(deps.containerAppsExecutionId);
    await deps.bus.completeCommand(message.lockToken);

    const deadline = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const phaseStartedAt = Date.now();
    let activeDeadlineMs = deadlineMs;
    let deadlineSetupError: unknown;
    try {
      activeDeadlineMs =
        deps.resolveCommandDeadlineMs?.(command) ?? deadlineMs;
      if (
        !Number.isSafeInteger(activeDeadlineMs)
        || activeDeadlineMs <= 0
      ) {
        throw new Error('Dispatch command has an invalid deadline');
      }
    } catch (error) {
      deadlineSetupError = error;
      activeDeadlineMs = 1;
    }
    const scheduleDeadline = (remainingMs: number): void => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(
        () => {
          const error = new Error('Execution deadline elapsed');
          error.name = 'AbortError';
          deadline.abort(error);
        },
        Math.max(1, remainingMs),
      );
    };
    const abortForShutdown = (): void => {
      deadline.abort(deps.signal?.reason);
    };
    if (deps.signal?.aborted) {
      abortForShutdown();
    } else {
      deps.signal?.addEventListener('abort', abortForShutdown, { once: true });
    }
    scheduleDeadline(activeDeadlineMs);
    let heartbeatTimer: ReturnType<typeof setInterval> | null = setInterval(
      () => {
        void checkpoints.publishHeartbeat().catch(() => undefined);
      },
      heartbeatMs,
    );
    const stopHeartbeat = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    try {
      if (deadlineSetupError) throw deadlineSetupError;
      const specification = await raceWithAbort(
        specifications.read(command.specRef, deadline.signal),
        deadline.signal,
      );
      if (deps.resolveDeadlineMs) {
        const specificationDeadlineMs = deps.resolveDeadlineMs(specification);
        if (
          !Number.isSafeInteger(specificationDeadlineMs)
          || specificationDeadlineMs <= 0
        ) {
          throw new Error('Execution specification has an invalid deadline');
        }
        const elapsedMs = Math.max(0, Date.now() - phaseStartedAt);
        const specificationRemainingMs = specificationDeadlineMs - elapsedMs;
        const commandRemainingMs = activeDeadlineMs - elapsedMs;
        const remainingMs = Math.min(
          commandRemainingMs,
          specificationRemainingMs,
        );
        activeDeadlineMs = elapsedMs + remainingMs;
        scheduleDeadline(remainingMs);
      }
      const outcome = await deps.execute({
        specification,
        command,
        checkpoints,
        signal: deadline.signal,
      });

      let manifestRef: AiRunBlobRef | undefined;
      if (outcome.files.length > 0) {
        await checkpoints.publishProgress('artifacts', 'uploading');
        const uploader = createArtifactUploader({
          target: { ...target, container: deps.artifactContainer },
        });
        manifestRef = await raceWithAbort(
          uploader.uploadAll(outcome.files, deadline.signal),
          deadline.signal,
        );
      }

      if (deadline.signal.aborted) {
        throw executionAbortError(deadline.signal);
      }
      await results.publishTerminal({
        status: 'completed',
        artifactStatus: manifestRef ? 'manifest_written' : 'pending',
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(manifestRef === undefined ? {} : { manifestRef }),
        ...(outcome.durationMs === undefined
          ? {}
          : { durationMs: outcome.durationMs }),
        ...(outcome.usage === undefined ? {} : outcome.usage),
      });
      return 'completed';
    } catch (error) {
      const usage =
        error instanceof CursorExecutionWaitError ? error.usage : undefined;
      await results.publishTerminal({
        status: 'failed',
        artifactStatus: 'failed',
        failureCategory: failureCategoryFor(error),
        detail: error instanceof Error ? error.message : String(error),
        ...(usage ?? {}),
      });
      return 'failed';
    } finally {
      stopHeartbeat();
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deps.signal?.removeEventListener('abort', abortForShutdown);
    }
  }

  return {
    processOnce,
    async runLoop(): Promise<void> {
      while (!deps.signal?.aborted) {
        try {
          const outcome = await processOnce();
          if (outcome === 'idle') await sleep(1_000);
        } catch (error) {
          console.error(
            '[aiRunsV2Worker]',
            error instanceof Error ? error.message : String(error),
          );
          await sleep(2_000);
        }
      }
    },
  };
}
