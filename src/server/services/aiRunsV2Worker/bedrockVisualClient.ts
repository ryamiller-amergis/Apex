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

export const DEFAULT_VISUAL_MAX_TOKENS = 16_000;
export const DEFAULT_VISUAL_TIMEOUT_MS = 10 * 60_000;

export type VisualModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
}>;

export type VisualModelResult = Readonly<{
  html: string;
  usage: VisualModelUsage;
  durationMs: number;
}>;

export type BedrockVisualClient = {
  invokeModel(
    prompt: string,
    model: VisualModelSettings,
  ): Promise<VisualModelResult>;
};

type SendableClient = Pick<BedrockRuntimeClient, 'send'>;

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
    async invokeModel(prompt, model) {
      const command = new InvokeModelCommand({
        modelId: model.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: model.maxTokens ?? DEFAULT_VISUAL_MAX_TOKENS,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const startedAt = now();
      const controller = new AbortController();
      const timeoutMs = model.timeoutMs ?? DEFAULT_VISUAL_TIMEOUT_MS;
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
