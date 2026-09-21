/**
 * Long-running V2 AI orchestrator process entrypoint.
 * Do not import/start from App Service index.ts — separate Container App only.
 */
import { db } from '../../db/drizzle';
import { runAttemptRepository } from '../aiRunV2/runAttemptRepository';
import { emptyUtilization } from './providerGovernor';
import { createOutboxDrainer } from './outboxDrainer';
import { createCheckpointConsumer } from './checkpointConsumer';
import { createResultConsumer } from './resultConsumer';
import { createReconciler } from './reconciler';
import { createOrchestrator } from './orchestrator';
import { createOrchestratorMetrics, setOrchestratorTrackEvent } from './metrics';
import {
  createServiceBusRestCommandPublisher,
  createServiceBusRestQueueConsumer,
} from './serviceBusRestClient';
import type { ExecutionProbe } from './ports';
import type { ProviderUtilization } from './types';

const executor = { execute: (query: unknown) => db.execute(query as never) };

function resolveNamespace(): string {
  return (
    process.env.AI_PLATFORM_V2_SERVICEBUS_NAMESPACE?.trim() ||
    process.env.AI_RUNS_SERVICEBUS_NAMESPACE?.trim() ||
    ''
  );
}

function createNoopExecutionProbe(): ExecutionProbe {
  return {
    async probe() {
      return { status: 'unknown', detail: 'execution probe not configured' };
    },
  };
}

async function loadUtilization(): Promise<ProviderUtilization> {
  // Placeholder until Task 5 wires live provider counters from attempt rows.
  return emptyUtilization();
}

async function main(): Promise<void> {
  if (process.env.AI_ORCHESTRATOR_ENABLED?.trim().toLowerCase() === 'false') {
    console.log('[aiOrchestrator] AI_ORCHESTRATOR_ENABLED=false — exiting');
    return;
  }

  try {
    // Optional App Insights hook when the host provides trackEvent globally.
    const insights = (globalThis as { appInsights?: { trackEvent?: unknown } })
      .appInsights;
    if (insights && typeof insights.trackEvent === 'function') {
      setOrchestratorTrackEvent((name, properties, measurements) => {
        (insights.trackEvent as Function)({
          name,
          properties,
          measurements,
        });
      });
    }
  } catch {
    /* ignore */
  }

  const namespace = resolveNamespace();
  const noopBus =
    !namespace ||
    process.env.AI_ORCHESTRATOR_SB_MODE?.trim().toLowerCase() === 'noop' ||
    process.env.NODE_ENV === 'test';

  const publisher = createServiceBusRestCommandPublisher({
    namespace: namespace || 'noop.servicebus.windows.net',
    queueName: 'ai-runs-v2-document',
    noop: noopBus,
  });
  const checkpointConsumerPort = createServiceBusRestQueueConsumer({
    namespace: namespace || 'noop.servicebus.windows.net',
    queueName:
      process.env.AI_PLATFORM_V2_CHECKPOINT_QUEUE?.trim() ||
      'ai-runs-v2-checkpoint',
    noop: noopBus,
  });
  const resultConsumerPort = createServiceBusRestQueueConsumer({
    namespace: namespace || 'noop.servicebus.windows.net',
    queueName:
      process.env.AI_PLATFORM_V2_RESULT_QUEUE?.trim() || 'ai-runs-v2-result',
    noop: noopBus,
  });

  const metrics = createOrchestratorMetrics();
  const abort = new AbortController();

  const reconciler = createReconciler({
    executor,
    attempts: runAttemptRepository,
    executionProbe: createNoopExecutionProbe(),
    metrics,
  });

  const outboxDrainer = createOutboxDrainer({
    executor,
    publisher,
    getUtilization: loadUtilization,
    getUncertainWorkerCount: () => reconciler.countUncertainWorkers(),
    metrics,
    enableNotify: process.env.NODE_ENV !== 'test',
  });

  const checkpointConsumer = createCheckpointConsumer({
    consumer: checkpointConsumerPort,
    attempts: runAttemptRepository,
    metrics,
    signal: abort.signal,
  });
  const resultConsumer = createResultConsumer({
    consumer: resultConsumerPort,
    attempts: runAttemptRepository,
    metrics,
    signal: abort.signal,
  });

  const orchestrator = createOrchestrator({
    outboxDrainer,
    checkpointConsumer,
    resultConsumer,
    reconciler,
    metrics,
    signal: abort.signal,
  });

  const shutdown = async (signal: string) => {
    console.log(`[aiOrchestrator] shutting down on ${signal}`);
    abort.abort();
    await orchestrator.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(
    `[aiOrchestrator] starting (sb=${noopBus ? 'noop' : namespace})`,
  );
  await orchestrator.start();
}

// Only auto-run when executed as the process entrypoint.
const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  main().catch((err) => {
    console.error(
      '[aiOrchestrator] fatal:',
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  });
}

export { main as startAiOrchestratorMain };
