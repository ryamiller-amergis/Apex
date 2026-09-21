/**
 * Visual lane worker process (Task 6).
 * Started only as its own container — never from App Service index.ts.
 */
import { createWorkerServiceBusClient } from './serviceBusClient';
import { resolveWorkerEnvironment } from './entrypointSupport';
import {
  createVisualConcurrencyController,
  isBedrockThrottle,
} from './visualConcurrency';
import { createV2Worker, type ExecuteWorkload } from './worker';

/**
 * Visual generation is not wired to Bedrock yet; Task 8 routes real work here.
 * The concurrency controller is live so throttle handling is exercised from
 * the first real run rather than bolted on later.
 */
const executeVisualWorkload: ExecuteWorkload = async ({ checkpoints }) => {
  await checkpoints.publishProgress('execution', 'pending');
  throw new Error('Visual lane execution is not wired yet');
};

export async function startVisualWorker(): Promise<void> {
  const env = resolveWorkerEnvironment('visual');
  const abort = new AbortController();
  const concurrency = createVisualConcurrencyController();

  const worker = createV2Worker({
    bus: createWorkerServiceBusClient({
      namespace: env.namespace || 'noop.servicebus.windows.net',
      commandQueue: env.commandQueue,
      checkpointQueue: env.checkpointQueue,
      resultQueue: env.resultQueue,
      noop: env.noop,
    }),
    execute: async (input) => {
      try {
        const outcome = await executeVisualWorkload(input);
        concurrency.recordSuccess();
        return outcome;
      } catch (error) {
        if (isBedrockThrottle(error)) {
          const level = concurrency.recordThrottle();
          console.warn(
            `[aiRunsV2Worker/visual] Bedrock throttled — concurrency now ${level}`,
          );
        }
        throw error;
      }
    },
    artifactContainer: env.artifactContainer,
    containerAppsExecutionId: env.containerAppsExecutionId,
    signal: abort.signal,
  });

  const shutdown = (signal: string): void => {
    console.log(`[aiRunsV2Worker/visual] shutting down on ${signal}`);
    abort.abort();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(
    `[aiRunsV2Worker/visual] starting (queue=${env.commandQueue}, concurrency=${concurrency.current()}, sb=${
      env.noop ? 'noop' : env.namespace
    })`,
  );
  await worker.runLoop();
}

const isMain =
  typeof require !== 'undefined' &&
  typeof module !== 'undefined' &&
  require.main === module;

if (isMain) {
  startVisualWorker().catch((error) => {
    console.error(
      '[aiRunsV2Worker/visual] fatal:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
