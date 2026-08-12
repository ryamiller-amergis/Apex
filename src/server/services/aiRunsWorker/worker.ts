import type { DispatchMessage } from '../../../shared/types/agentRunAdmission';
import type { ExecutionSnapshot } from '../../../shared/types/agentRunLifecycle';
import type {
  AiRunBootstrapResponse,
  AiRunIngestBody,
  AiRunIngestResponse,
} from '../../../shared/types/aiRunIngest';
import {
  executeCursorExecutionCore,
  type CursorExecutionResult,
} from '../cursorExecutionCore';
import type { WorkerCursorExecution } from './cursorExecution';
import { AiRunFenceConflictError } from './callbackClient';

export const AI_RUNS_DEFAULT_HEARTBEAT_MS = 15_000;

export function resolveAiRunsHeartbeatMs(): number {
  const configured = Number(process.env.AI_RUNS_HEARTBEAT_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : AI_RUNS_DEFAULT_HEARTBEAT_MS;
}

class AiRunCancellationObservedError extends Error {
  constructor() {
    super('AI run cancellation requested');
    this.name = 'AiRunCancellationObservedError';
  }
}

export interface AiRunsWorkerDependencies {
  getBootstrap(dispatch: DispatchMessage): Promise<AiRunBootstrapResponse>;
  openCheckout(snapshot: Readonly<ExecutionSnapshot>): Promise<unknown>;
  createExecution(
    snapshot: Readonly<ExecutionSnapshot>,
    checkout: unknown,
  ): Promise<WorkerCursorExecution>;
  postIngest(
    projectId: string,
    runId: string,
    body: AiRunIngestBody,
  ): Promise<AiRunIngestResponse>;
  flushArtifacts(workspaceRef: string): Promise<void>;
  heartbeatIntervalMs?: number;
  sourceInstance?: string;
}

export type AiRunsWorker = {
  execute(dispatch: DispatchMessage): Promise<void>;
};

function isSuccessfulWait(result: CursorExecutionResult): boolean {
  return result.waitResult.status === 'finished'
    || result.waitResult.status === 'completed'
    || result.waitResult.status === 'success';
}

/** Keep failure details short, single-line, and safe for ingest/UI. */
const MAX_WORKER_FAILURE_DETAIL = 480;

export function formatWorkerExecutionFailure(error: unknown): string {
  const code =
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code.trim()
      : '';
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown error';
  const compact = `${code ? `${code}: ` : ''}${message}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_WORKER_FAILURE_DETAIL);
  return compact
    ? `Worker execution failed: ${compact}`
    : 'Worker execution failed';
}

/**
 * Thin fenced host. All callback traffic is serialized so the first observed
 * dispatch conflict closes the callback gate before any later callback starts.
 */
export function createAiRunsWorker(
  dependencies: AiRunsWorkerDependencies,
): AiRunsWorker {
  const heartbeatIntervalMs =
    dependencies.heartbeatIntervalMs ?? resolveAiRunsHeartbeatMs();
  const sourceInstance =
    dependencies.sourceInstance ?? 'ai-runs-background-worker';

  return {
    async execute(dispatch): Promise<void> {
      // Bootstrap precedes every project-scoped callback or workspace access.
      const bootstrap = await dependencies.getBootstrap(dispatch);
      const { projectId, run: bootstrapRun } = bootstrap;
      const snapshot = Object.freeze({ ...bootstrapRun.executionSnapshot });

      if (
        bootstrapRun.dispatchMessageId !== dispatch.dispatchMessageId
        || snapshot.projectId !== projectId
      ) {
        throw new AiRunFenceConflictError();
      }

      let execution: WorkerCursorExecution | undefined;
      let disposed = false;
      let cancellationRequested = bootstrapRun.cancelRequested;
      let fenceConflict: AiRunFenceConflictError | undefined;
      let asynchronousFailure: unknown;
      let callbackQueue: Promise<void> = Promise.resolve();
      let sequence = 0;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

      const dispose = async (): Promise<void> => {
        if (!execution || disposed) return;
        disposed = true;
        await execution.dispose().catch(() => {});
      };

      const stopRun = async (): Promise<void> => {
        if (!execution?.run.cancel) return;
        await execution.run.cancel().catch(() => {});
      };

      const post = (
        body: AiRunIngestBody,
        abortOnCancellation = true,
      ): Promise<void> => {
        const operation = callbackQueue.then(async () => {
          if (fenceConflict) throw fenceConflict;
          let response: AiRunIngestResponse;
          try {
            response = await dependencies.postIngest(
              projectId,
              dispatch.runId,
              body,
            );
          } catch (error) {
            if (error instanceof AiRunFenceConflictError) {
              fenceConflict = error;
              await stopRun();
            }
            throw error;
          }

          if (response.cancelRequested && body.kind !== 'cancel_ack') {
            cancellationRequested = true;
            await stopRun();
            if (abortOnCancellation) {
              throw new AiRunCancellationObservedError();
            }
          }
        });
        callbackQueue = operation.catch(() => {});
        return operation;
      };

      const clearHeartbeat = async (): Promise<void> => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        await callbackQueue;
        if (fenceConflict) throw fenceConflict;
        if (asynchronousFailure) throw asynchronousFailure;
      };

      const acknowledgeCancellation = async (): Promise<void> => {
        await post({
          dispatchMessageId: dispatch.dispatchMessageId,
          kind: 'cancel_ack',
          detail: 'Worker stopped',
        }, false);
      };

      try {
        await post({
          dispatchMessageId: dispatch.dispatchMessageId,
          kind: 'heartbeat',
        });

        if (cancellationRequested) {
          await acknowledgeCancellation();
          return;
        }

        const checkout = await dependencies.openCheckout(snapshot);
        execution = await dependencies.createExecution(snapshot, checkout);

        if (heartbeatIntervalMs > 0) {
          heartbeatTimer = setInterval(() => {
            void post({
              dispatchMessageId: dispatch.dispatchMessageId,
              kind: 'heartbeat',
            }).catch((error) => {
              asynchronousFailure = error;
              void stopRun();
            });
          }, heartbeatIntervalMs);
          heartbeatTimer.unref?.();
        }

        let result: CursorExecutionResult;
        try {
          result = await executeCursorExecutionCore({
            snapshot,
            run: execution.run,
            context: {
              runId: dispatch.runId,
              sourceInstance,
            },
            sink: {
              publish: (event, envelope) => post({
                dispatchMessageId: dispatch.dispatchMessageId,
                kind: 'progress',
                phase: envelope.phase,
                status: envelope.status,
                detail: envelope.detail,
                event,
              }),
            },
            hooks: {
              beforeStreamEvent: () => {
                if (fenceConflict) throw fenceConflict;
                if (asynchronousFailure) throw asynchronousFailure;
                if (cancellationRequested) {
                  throw new AiRunCancellationObservedError();
                }
              },
            },
            nextSequence: () => ++sequence,
          });
        } finally {
          await clearHeartbeat();
        }

        if (!isSuccessfulWait(result)) {
          throw new Error('Cursor execution did not finish successfully');
        }
        if (cancellationRequested) {
          throw new AiRunCancellationObservedError();
        }

        await dependencies.flushArtifacts(snapshot.workspaceRef);
        await post({
          dispatchMessageId: dispatch.dispatchMessageId,
          kind: 'terminal',
          status: 'completed',
          artifactsFlushed: true,
        });
      } catch (error) {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        await callbackQueue;

        if (fenceConflict || error instanceof AiRunFenceConflictError) {
          throw fenceConflict ?? error;
        }
        if (
          cancellationRequested
          || error instanceof AiRunCancellationObservedError
        ) {
          await acknowledgeCancellation();
          return;
        }

        await dependencies.flushArtifacts(snapshot.workspaceRef);
        const failureDetail = formatWorkerExecutionFailure(error);
        console.error(JSON.stringify({
          event: 'AiRunsWorkerExecutionFailed',
          runId: dispatch.runId,
          dispatchMessageId: dispatch.dispatchMessageId,
          workspaceRef: snapshot.workspaceRef,
          detail: failureDetail,
        }));
        await post({
          dispatchMessageId: dispatch.dispatchMessageId,
          kind: 'terminal',
          status: 'failed',
          detail: failureDetail,
          artifactsFlushed: true,
        });
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        await dispose();
      }
    },
  };
}
