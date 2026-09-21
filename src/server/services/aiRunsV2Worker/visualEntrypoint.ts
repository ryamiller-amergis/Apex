/**
 * Visual lane worker process (Task 6).
 * Started only as its own container — never from App Service index.ts.
 */
import {
  isAiRunV2VisualSpecification,
  type VisualModelSettings,
} from '../../../shared/types/aiRunV2VisualSpec';
import { createWorkerServiceBusClient } from './serviceBusClient';
import { resolveWorkerEnvironment } from './entrypointSupport';
import { buildPrototypePrompt } from './prototypePromptBuilder';
import {
  createBedrockVisualClient,
  type VisualModelResult,
} from './bedrockVisualClient';
import {
  createVisualConcurrencyController,
  isBedrockThrottle,
} from './visualConcurrency';
import { createV2Worker, type ExecuteWorkload } from './worker';

export const USAGE_FILE_NAME = 'usage.json';

export type InvokeVisualModel = (
  prompt: string,
  model: VisualModelSettings,
) => Promise<string | VisualModelResult>;

/**
 * Turns a visual specification into one HTML artifact.
 *
 * The model client is injected: a worker image binds the real Bedrock call,
 * and tests bind a fake, so nothing here reaches the network or a database.
 */
export function createVisualExecute(deps: {
  invokeModel: InvokeVisualModel;
}): ExecuteWorkload {
  return async ({ specification, checkpoints }) => {
    if (!isAiRunV2VisualSpecification(specification)) {
      throw new Error('Command referenced an invalid visual specification');
    }
    await checkpoints.publishProgress('execution', 'running');

    const result = await deps.invokeModel(
      buildPrototypePrompt(specification),
      specification.model,
    );
    const html = typeof result === 'string' ? result : result.html;
    if (!html.trim()) {
      // An empty upload would finalize the run as a completed blank prototype.
      throw new Error('Visual model returned no HTML');
    }

    const files = [
      {
        path: specification.outputPath,
        content: html,
        contentType: 'text/html',
      },
    ];

    // A worker cannot write a usage row, so the cost rides along as an
    // artifact and the owning service records it when it applies the output.
    if (typeof result !== 'string') {
      files.push({
        path: USAGE_FILE_NAME,
        content: JSON.stringify(
          {
            modelId: specification.model.modelId,
            feature: specification.usage.feature,
            project: specification.usage.project,
            userId: specification.usage.userId,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            durationMs: result.durationMs,
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    }

    return { files };
  };
}

const executeVisualWorkload: ExecuteWorkload = createVisualExecute({
  invokeModel: (prompt, model) =>
    createBedrockVisualClient().invokeModel(prompt, model),
});

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
