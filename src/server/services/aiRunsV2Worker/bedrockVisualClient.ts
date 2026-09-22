/**
 * Bedrock client for the visual worker.
 *
 * Separate from `bedrockService` on purpose: that module writes usage rows
 * through `recordAiUsage`, which reaches PostgreSQL and would break worker
 * isolation. This one returns the tokens it was told about and lets the owning
 * service record the cost, where a database exists.
 */
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { VisualModelSettings } from '../../../shared/types/aiRunV2VisualSpec';

export type VisualModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
}>;

export type VisualModelResult = Readonly<{
  html: string;
  usage: VisualModelUsage;
  durationMs: number;
}>;

/**
 * The design reference the model looks at, already fetched into the
 * specification. A worker cannot call Figma, so if it is not here the model
 * generates blind against a prompt that tells it to match a screenshot.
 */
export type VisualReferenceImage = Readonly<{
  base64: string;
  mediaType: string;
}>;

export type BedrockVisualClient = {
  invokeModel(
    prompt: string,
    model: VisualModelSettings,
    image?: VisualReferenceImage,
  ): Promise<VisualModelResult>;
};

type SendableClient = Pick<BedrockRuntimeClient, 'send'>;

/**
 * Mirrors `bedrockService.invokeModel`: the image block comes first and the
 * text second. That ordering is part of what produces today's output, so it
 * is kept rather than chosen. With no image the message stays a plain string,
 * which is what a reference-less in-process call sends.
 */
function buildContent(
  prompt: string,
  image?: VisualReferenceImage,
): string | unknown[] {
  if (!image?.base64) return prompt;

  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.base64,
      },
    },
    { type: 'text', text: prompt },
  ];
}

export function createBedrockVisualClient(options?: {
  client?: SendableClient;
  region?: string;
  now?: () => number;
}): BedrockVisualClient {
  const client =
    options?.client ??
    new BedrockRuntimeClient({
      region: options?.region ?? process.env.AWS_REGION ?? 'us-east-1',
    });
  const now = options?.now ?? Date.now;

  return {
    async invokeModel(prompt, model, image) {
      const command = new InvokeModelCommand({
        modelId: model.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: model.maxTokens,
          messages: [{ role: 'user', content: buildContent(prompt, image) }],
          // Only where the specification carries one: UI Lab's in-process
          // payload omits the key when the project set no temperature, and
          // the model's own default is not the worker's to choose.
          ...(model.temperature !== undefined
            ? { temperature: model.temperature }
            : {}),
        }),
      });

      const startedAt = now();
      const controller = new AbortController();
      const { timeoutMs } = model;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await (client as BedrockRuntimeClient).send(command, {
          abortSignal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(
            `Bedrock request timed out after ${Math.round(
              timeoutMs / 1000,
            )}s (model=${model.modelId})`,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }

      const decoded = JSON.parse(
        new TextDecoder().decode(response.body as Uint8Array),
      ) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      return {
        html: decoded.content?.[0]?.text ?? '',
        usage: {
          inputTokens: decoded.usage?.input_tokens ?? 0,
          outputTokens: decoded.usage?.output_tokens ?? 0,
        },
        durationMs: now() - startedAt,
      };
    },
  };
}
