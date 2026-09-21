/**
 * Document lane worker process (Task 6).
 * Started only as its own container — never from App Service index.ts.
 */
import { createWorkerServiceBusClient } from './serviceBusClient';
import { resolveWorkerEnvironment } from './entrypointSupport';
import {
  createV2Worker,
  LARGE_PHASE_DEADLINE_MS,
  NORMAL_PHASE_DEADLINE_MS,
  type ExecuteWorkload,
} from './worker';

/**
 * Document generation is not wired to a provider yet; Task 8 routes real work
 * here. Until then the worker proves the protocol and refuses to invent
 * output.
 */
const executeDocumentWorkload: ExecuteWorkload = async ({ checkpoints }) => {
  await checkpoints.publishProgress('execution', 'pending');
  throw new Error('Document lane execution is not wired yet');
};

export async function startDocumentWorker(): Promise<void> {
  const env = resolveWorkerEnvironment('document');
  const abort = new AbortController();

  const worker = createV2Worker({
    bus: createWorkerServiceBusClient({
      namespace: env.namespace || 'noop.servicebus.windows.net',
      commandQueue: env.commandQueue,
      checkpointQueue: env.checkpointQueue,
      resultQueue: env.resultQueue,
      noop: env.noop,
    }),
    execute: executeDocumentWorkload,
    artifactContainer: env.artifactContainer,
    containerAppsExecutionId: env.containerAppsExecutionId,
    deadlineMs:
      process.env.AI_RUNS_V2_LARGE_PHASE === 'true'
        ? LARGE_PHASE_DEADLINE_MS
        : NORMAL_PHASE_DEADLINE_MS,
    signal: abort.signal,
  });

  const shutdown = (signal: string): void => {
    console.log(`[aiRunsV2Worker/document] shutting down on ${signal}`);
    abort.abort();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log(
    `[aiRunsV2Worker/document] starting (queue=${env.commandQueue}, sb=${
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
  startDocumentWorker().catch((error) => {
    console.error(
      '[aiRunsV2Worker/document] fatal:',
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
