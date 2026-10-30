/**
 * Terminal result consumer — fenced finalize + poison dead-letter.
 */
import {
  isAiRunV2ActiveAttemptStatus,
  isAiRunV2FailureCategory,
  isAiRunV2Result,
  type AiRunV2AttemptStatus,
  type AiRunV2FailureCategory,
  type AiRunV2Result,
} from '../../../shared/types/aiRunV2';
import { applyTerminalRunEffects as defaultTerminalEffects } from '../agentRunTerminalEffects';
import type {
  RunAttemptRepository,
  TransitionAttemptResult,
} from '../aiRunV2/runAttemptRepository';
import { recordV2TerminalUsage as defaultRecordTerminalUsage } from '../aiRunV2/runUsageRecorder';
import type { Clock, OrchestratorMetrics, QueueConsumer } from './ports';
import { noopMetrics, systemClock } from './ports';

export type ResultConsumerDeps = Readonly<{
  consumer: QueueConsumer;
  attempts: RunAttemptRepository;
  clock?: Clock;
  metrics?: OrchestratorMetrics;
  signal?: AbortSignal;
  maxDeliveryCount?: number;
  applyTerminalRunEffects?: typeof defaultTerminalEffects;
  recordTerminalUsage?: typeof defaultRecordTerminalUsage;
  /** Called at the start of every loop pass. */
  onProgress?: () => void;
}>;

type RefusedTransition = Exclude<TransitionAttemptResult, { status: 'ok' }>;

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
  const applyTerminalEffects =
    deps.applyTerminalRunEffects ?? defaultTerminalEffects;
  const recordTerminalUsage =
    deps.recordTerminalUsage ?? defaultRecordTerminalUsage;

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

    const settleRefused = async (
      refusal: RefusedTransition,
    ): Promise<'processed' | 'poison'> => {
      switch (refusal.status) {
        case 'fence_mismatch':
          await deps.consumer.deadLetter(
            message.lockToken,
            'fence_mismatch',
            'Stale dispatch fence on terminal result',
          );
          metrics.increment('orchestrator.result.fence_mismatch');
          return 'poison';
        case 'not_found':
          await deps.consumer.complete(message.lockToken);
          metrics.increment('orchestrator.result.not_found');
          return 'processed';
        case 'illegal_transition':
          if (isAiRunV2ActiveAttemptStatus(refusal.from)) {
            // The attempt is still live (its checkpoint may not have landed
            // yet), so acknowledging would lose the result.
            if (message.deliveryCount >= maxDelivery) {
              await deps.consumer.deadLetter(
                message.lockToken,
                'illegal_transition',
                `Cannot apply ${refusal.to} result to ${refusal.from} attempt`,
              );
              metrics.increment('orchestrator.result.illegal_transition');
              return 'poison';
            }
            await deps.consumer.abandon(message.lockToken);
            metrics.increment('orchestrator.result.retry');
            return 'processed';
          }
          // Already terminal — treat as idempotent success.
          await deps.consumer.complete(message.lockToken);
          metrics.increment('orchestrator.result.idempotent');
          return 'processed';
        default: {
          const unhandled: never = refusal;
          throw new Error(`Unhandled refusal: ${String(unhandled)}`);
        }
      }
    };

    try {
      if (result.status === 'failed' && failureCategory === 'worker_lost') {
        const replacement = await deps.attempts.replaceLostAttempt({
          attemptId: result.attemptId,
          expectedDispatchMessageId: result.dispatchMessageId,
          artifactStatus: result.artifactStatus,
          failureDetail: result.detail,
        });
        switch (replacement.status) {
          case 'replaced':
            // Usage is recorded only for the attempt that ends the run, so a
            // replaced attempt never books a terminal `error` usage row.
            await deps.consumer.complete(message.lockToken);
            metrics.increment('orchestrator.result.attempt_replaced');
            return 'processed';
          case 'run_terminal':
            // The run already ended (usually a user cancel), and whatever
            // ended it ran the terminal effects. Leave its header alone.
            await deps.consumer.complete(message.lockToken);
            metrics.increment('orchestrator.result.lost_attempt_closed', {
              runStatus: replacement.runStatus,
            });
            return 'processed';
          case 'fence_mismatch':
          case 'not_found':
          case 'illegal_transition':
            return settleRefused(replacement);
          case 'attempts_exhausted':
          case 'deadline_elapsed':
          case 'retry_context_missing':
            metrics.increment('orchestrator.result.replacement_skipped', {
              reason: replacement.status,
            });
            break;
          default: {
            const unhandled: never = replacement;
            throw new Error(
              `Unhandled replacement outcome: ${String(unhandled)}`,
            );
          }
        }
      }

      const transition = await deps.attempts.transitionAttempt({
        attemptId: result.attemptId,
        expectedDispatchMessageId: result.dispatchMessageId,
        to: mapExecutionStatus(result.status),
        artifactStatus: result.artifactStatus,
        failureCategory,
        failureDetail: result.detail,
        manifestRef: result.manifestRef ?? null,
      });

      if (transition.status !== 'ok') {
        return settleRefused(transition);
      }

      await recordTerminalUsage(result);

      // The attempt transaction wrote the run header but nothing else a V1
      // terminal does. Run the shared effects on the header it returned, then
      // acknowledge — a redelivery would be refused as an illegal transition
      // and never reach this point again.
      if (transition.run) {
        await applyTerminalEffects({
          run: transition.run,
          detail: result.detail,
          terminalEventsPersisted: false,
        });
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
        deps.onProgress?.();
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
