/**
 * Compose outbox drain, consumers, and reconciler under one AbortSignal.
 */
import type { OutboxDrainer } from './outboxDrainer';
import type { CheckpointConsumer } from './checkpointConsumer';
import type { ResultConsumer } from './resultConsumer';
import type { Reconciler } from './reconciler';
import type { Clock, OrchestratorMetrics } from './ports';
import { noopMetrics, systemClock } from './ports';

export type OrchestratorDeps = Readonly<{
  outboxDrainer: OutboxDrainer;
  checkpointConsumer: CheckpointConsumer;
  resultConsumer: ResultConsumer;
  reconciler: Reconciler;
  clock?: Clock;
  metrics?: OrchestratorMetrics;
  reconcilerIntervalMs?: number;
  signal?: AbortSignal;
}>;

export type Orchestrator = {
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const clock = deps.clock ?? systemClock;
  const metrics = deps.metrics ?? noopMetrics;
  const reconcilerIntervalMs = deps.reconcilerIntervalMs ?? 30_000;

  let localAbort: AbortController | null = null;
  let reconcilerTimer: ReturnType<typeof setInterval> | null = null;
  const loops: Promise<void>[] = [];
  let started = false;

  const orchestrator: Orchestrator = {
    async start(): Promise<void> {
      if (started) return;
      started = true;
      localAbort = new AbortController();
      const signal = deps.signal ?? localAbort.signal;

      await deps.outboxDrainer.start();

      loops.push(
        deps.checkpointConsumer.runLoop(),
        deps.resultConsumer.runLoop(),
      );

      const runReconciler = async () => {
        try {
          await deps.reconciler.runOnce();
        } catch (err) {
          metrics.increment('orchestrator.reconciler.error');
          console.error(
            '[aiOrchestrator]',
            err instanceof Error ? err.message : String(err),
          );
        }
      };
      await runReconciler();
      reconcilerTimer = setInterval(() => {
        void runReconciler();
      }, reconcilerIntervalMs);
      reconcilerTimer.unref?.();

      const onAbort = () => {
        void orchestrator.stop();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      metrics.increment('orchestrator.started');
      void clock;
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      if (reconcilerTimer) {
        clearInterval(reconcilerTimer);
        reconcilerTimer = null;
      }
      localAbort?.abort();
      await deps.outboxDrainer.stop();
      metrics.increment('orchestrator.stopped');
      await Promise.race([Promise.allSettled(loops), clock.sleep(5_000)]);
    },
  };

  return orchestrator;
}
