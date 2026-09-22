/**
 * Document lane worker process (Task 6).
 * Started only as its own container — never from App Service index.ts.
 */
import { createWorkerServiceBusClient } from './serviceBusClient';
import { resolveWorkerEnvironment } from './entrypointSupport';
import { isAiRunV2DocumentSpecification } from '../../../shared/types/aiRunV2DocumentSpec';
import { createDocumentExecute } from './documentExecution';
import { createV2Worker } from './worker';

export const executeDocumentWorkload = createDocumentExecute();

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
    resolveDeadlineMs: (specification) => {
      if (!isAiRunV2DocumentSpecification(specification)) {
        throw new Error('Command referenced an invalid document specification');
      }
      return specification.deadlineMs;
    },
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
