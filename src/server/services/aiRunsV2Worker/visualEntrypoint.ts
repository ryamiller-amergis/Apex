/**
 * Visual lane worker process (Task 6).
 * Started only as its own container — never from App Service index.ts.
 */
import {
  isAiRunV2VisualSpecification,
  VISUAL_USAGE_FILE_NAME,
  type AiRunV2VisualSpecification,
  type DesignPrototypeVisualSpecification,
  type VisualModelSettings,
} from '../../../shared/types/aiRunV2VisualSpec';
import { createWorkerServiceBusClient } from './serviceBusClient';
import { resolveWorkerEnvironment } from './entrypointSupport';
import {
  buildProjectPrototypePrompt,
  buildPrototypePrompt,
} from './prototypePromptBuilder';
import { buildUiLabPrompt } from './uiLabPromptBuilder';
import {
  createBedrockVisualClient,
  type VisualModelResult,
  type VisualReferenceImage,
} from './bedrockVisualClient';
import {
  createVisualConcurrencyController,
  isBedrockThrottle,
} from './visualConcurrency';
import { createV2Worker, type ExecuteWorkload } from './worker';

export const USAGE_FILE_NAME = VISUAL_USAGE_FILE_NAME;

export type InvokeVisualModel = (
  prompt: string,
  model: VisualModelSettings,
  image?: VisualReferenceImage,
) => Promise<string | VisualModelResult>;

/**
 * The reference screenshot both in-process visual paths attach as a vision
 * input, resolved on App Service and carried here. Optional throughout:
 * `getFigmaReference` returns no screenshot when the asset is missing, and
 * both in-process callers send text only in that case.
 *
 * The media type defaults to png because that is what `bedrockService` and
 * `uiLabBedrockService` hardcode for the Figma reference.
 */
function visualReferenceImage(
  specification: AiRunV2VisualSpecification,
): VisualReferenceImage | undefined {
  const { screenshotBase64, screenshotMediaType } = specification.designReference;
  if (!screenshotBase64) return undefined;

  return {
    base64: screenshotBase64,
    mediaType: screenshotMediaType ?? 'image/png',
  };
}

/**
 * A prototype run has two prompts to choose between and the subject kind
 * cannot separate them, so the specification names the branch and this
 * switch obeys it. Answering a project that ships its own design system with
 * the MaxView prompt is the same failure one level down: a finished-looking
 * prototype built against the wrong design system.
 */
function buildDesignPrototypePrompt(
  specification: DesignPrototypeVisualSpecification,
): string {
  const { prototypePrompt } = specification;
  switch (prototypePrompt.branch) {
    case 'maxview':
      return buildPrototypePrompt(specification);
    case 'project-design-system':
      return buildProjectPrototypePrompt(specification, prototypePrompt);
    default: {
      const unhandled: never = prototypePrompt;
      throw new Error(
        `Unsupported prototype prompt branch: ${String(
          (unhandled as { branch?: unknown }).branch,
        )}`,
      );
    }
  }
}

/**
 * The lane carries more than one kind of subject and each needs its own
 * prompt, so the kind has to decide the builder. Falling through to one of
 * them would answer the other with the wrong instructions — output that looks
 * finished and is wrong, with nothing to flag it. The `never` check keeps a
 * third kind from compiling until it is handled here too.
 */
function buildVisualPrompt(specification: AiRunV2VisualSpecification): string {
  switch (specification.subjectKind) {
    case 'design-prototype':
      return buildDesignPrototypePrompt(specification);
    case 'ui-lab-screen':
      return buildUiLabPrompt(specification);
    default: {
      // The specification itself is `never` here, so a third subject kind
      // stops compiling until it has a case of its own.
      const unhandled: never = specification;
      throw new Error(
        `Unsupported visual subjectKind: ${String(
          (unhandled as { subjectKind?: unknown }).subjectKind,
        )}`,
      );
    }
  }
}

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
      buildVisualPrompt(specification),
      specification.model,
      visualReferenceImage(specification),
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
  invokeModel: (prompt, model, image) =>
    createBedrockVisualClient().invokeModel(prompt, model, image),
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
