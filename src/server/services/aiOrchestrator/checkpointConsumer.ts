/**
 * Checkpoint consumer pool — never terminalizes on a missed heartbeat alone.
 */
import {
  isAiRunV2Checkpoint,
  type AiRunV2Checkpoint,
} from '../../../shared/types/aiRunV2';
import type { RunAttemptRepository } from '../aiRunV2/runAttemptRepository';
import type { Clock, OrchestratorMetrics, QueueConsumer } from './ports';
import { noopMetrics, systemClock } from './ports';

export type CheckpointConsumerDeps = Readonly<{
  consumer: QueueConsumer;
  attempts: RunAttemptRepository;
  clock?: Clock;
  metrics?: OrchestratorMetrics;
  signal?: AbortSignal;
  maxDeliveryCount?: number;
}>;

export type CheckpointConsumer = {
  processOnce(): Promise<'processed' | 'idle' | 'poison'>;
  runLoop(): Promise<void>;
};

function asCheckpoint(body: Record<string, unknown>): AiRunV2Checkpoint | null {
  if (!isAiRunV2Checkpoint(body)) return null;
  return body;
}

export function createCheckpointConsumer(
  deps: CheckpointConsumerDeps,
): CheckpointConsumer {
  const metrics = deps.metrics ?? noopMetrics;
  const clock = deps.clock ?? systemClock;
  const maxDelivery = deps.maxDeliveryCount ?? 5;

  async function processOnce(): Promise<'processed' | 'idle' | 'poison'> {
    const message = await deps.consumer.receive({ timeoutSeconds: 5 });
    if (!message) return 'idle';

    const checkpoint = asCheckpoint(message.body);
    if (!checkpoint) {
      if (message.deliveryCount >= maxDelivery) {
        await deps.consumer.deadLetter(
          message.lockToken,
          'poison_message',
          'Checkpoint payload failed schema validation',
        );
        metrics.increment('orchestrator.checkpoint.poison');
        return 'poison';
      }
      await deps.consumer.abandon(message.lockToken);
      metrics.increment('orchestrator.checkpoint.invalid');
      return 'poison';
    }

    const result = await deps.attempts.acceptCheckpoint(checkpoint);
    switch (result.status) {
      case 'accepted':
      case 'duplicate':
      case 'stale_sequence':
        await deps.consumer.complete(message.lockToken);
        metrics.increment('orchestrator.checkpoint.handled', {
          status: result.status,
        });
        return 'processed';
      case 'fence_mismatch':
        await deps.consumer.deadLetter(
          message.lockToken,
          'fence_mismatch',
          'Stale dispatch fence on checkpoint',
        );
        metrics.increment('orchestrator.checkpoint.fence_mismatch');
        return 'poison';
      case 'not_found':
        await deps.consumer.abandon(message.lockToken);
        metrics.increment('orchestrator.checkpoint.not_found');
        return 'processed';
      default: {
        const _exhaustive: never = result;
        void _exhaustive;
        await deps.consumer.abandon(message.lockToken);
        return 'processed';
      }
    }
  }

  return {
    processOnce,
    async runLoop(): Promise<void> {
      while (!deps.signal?.aborted) {
        try {
          const outcome = await processOnce();
          if (outcome === 'idle') {
            await clock.sleep(250);
          }
        } catch (err) {
          metrics.increment('orchestrator.checkpoint.loop_error');
          console.error(
            '[aiOrchestrator/checkpointConsumer]',
            err instanceof Error ? err.message : String(err),
          );
          await clock.sleep(1_000);
        }
      }
    },
  };
}
