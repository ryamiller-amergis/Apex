/**
 * Terminal result consumer — fenced finalize + poison dead-letter.
 */
import {
  isAiRunV2FailureCategory,
  isAiRunV2Result,
  type AiRunV2AttemptStatus,
  type AiRunV2FailureCategory,
  type AiRunV2Result,
} from '../../../shared/types/aiRunV2';
import type { RunAttemptRepository } from '../aiRunV2/runAttemptRepository';
import type { Clock, OrchestratorMetrics, QueueConsumer } from './ports';
import { noopMetrics, systemClock } from './ports';

export type ResultConsumerDeps = Readonly<{
  consumer: QueueConsumer;
  attempts: RunAttemptRepository;
  clock?: Clock;
  metrics?: OrchestratorMetrics;
  signal?: AbortSignal;
  maxDeliveryCount?: number;
}>;

export type ResultConsumer = {
  processOnce(): Promise<'processed' | 'idle' | 'poison'>;
  runLoop(): Promise<void>;
};

function mapExecutionStatus(
  status: AiRunV2Result['status'],
): AiRunV2AttemptStatus {
  return status;
}

export function createResultConsumer(deps: ResultConsumerDeps): ResultConsumer {
  const metrics = deps.metrics ?? noopMetrics;
  const clock = deps.clock ?? systemClock;
  const maxDelivery = deps.maxDeliveryCount ?? 5;

  async function processOnce(): Promise<'processed' | 'idle' | 'poison'> {
    const message = await deps.consumer.receive({ timeoutSeconds: 5 });
    if (!message) return 'idle';

    if (!isAiRunV2Result(message.body)) {
      if (message.deliveryCount >= maxDelivery) {
        await deps.consumer.deadLetter(
          message.lockToken,
          'poison_message',
          'Terminal result failed schema validation',
        );
        metrics.increment('orchestrator.result.poison');
        return 'poison';
      }
      await deps.consumer.abandon(message.lockToken);
      return 'poison';
    }

    const result = message.body;
    const failureCategory: AiRunV2FailureCategory | undefined =
      result.failureCategory && isAiRunV2FailureCategory(result.failureCategory)
        ? result.failureCategory
        : result.status === 'failed'
          ? 'internal_error'
          : undefined;

    try {
      const transition = await deps.attempts.transitionAttempt({
        attemptId: result.attemptId,
        expectedDispatchMessageId: result.dispatchMessageId,
        to: mapExecutionStatus(result.status),
        artifactStatus: result.artifactStatus,
        failureCategory,
        failureDetail: result.detail,
        manifestRef: result.manifestRef ?? null,
      });

      if (transition.status === 'fence_mismatch') {
        await deps.consumer.deadLetter(
          message.lockToken,
          'fence_mismatch',
          'Stale dispatch fence on terminal result',
        );
        metrics.increment('orchestrator.result.fence_mismatch');
        return 'poison';
      }
      if (transition.status === 'not_found') {
        await deps.consumer.complete(message.lockToken);
        metrics.increment('orchestrator.result.not_found');
        return 'processed';
      }
      if (transition.status === 'illegal_transition') {
        // Already terminal or racing — treat as idempotent success.
        await deps.consumer.complete(message.lockToken);
        metrics.increment('orchestrator.result.idempotent');
        return 'processed';
      }

      await deps.consumer.complete(message.lockToken);
      metrics.increment('orchestrator.result.finalized', {
        status: result.status,
      });
      return 'processed';
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (message.deliveryCount >= maxDelivery) {
        await deps.consumer.deadLetter(
          message.lockToken,
          'poison_message',
          detail,
        );
        // Best-effort terminalize user-visible run after poison.
        await deps.attempts
          .transitionAttempt({
            attemptId: result.attemptId,
            expectedDispatchMessageId: result.dispatchMessageId,
            to: 'failed',
            failureCategory: 'poison_message',
            failureDetail: detail,
          })
          .catch(() => undefined);
        metrics.increment('orchestrator.result.poison_terminalized');
        return 'poison';
      }
      await deps.consumer.abandon(message.lockToken);
      metrics.increment('orchestrator.result.retry');
      return 'processed';
    }
  }

  return {
    processOnce,
    async runLoop(): Promise<void> {
      while (!deps.signal?.aborted) {
        try {
          const outcome = await processOnce();
          if (outcome === 'idle') await clock.sleep(250);
        } catch (err) {
          metrics.increment('orchestrator.result.loop_error');
          console.error(
            '[aiOrchestrator/resultConsumer]',
            err instanceof Error ? err.message : String(err),
          );
          await clock.sleep(1_000);
        }
      }
    },
  };
}
