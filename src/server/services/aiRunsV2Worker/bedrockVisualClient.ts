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
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { VisualModelSettings } from '../../../shared/types/aiRunV2VisualSpec';

export type VisualModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
    images?: ReadonlyArray<VisualReferenceImage>,
    signal?: AbortSignal,
  ): Promise<VisualModelResult>;
  invokeStreamingModel(
    prompt: string,
    model: VisualModelSettings,
    images: ReadonlyArray<VisualReferenceImage>,
    onText: (text: string) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<VisualModelResult>;
};

/**
 * Thrown when Bedrock stops on `stop_reason: 'max_tokens'` — the model was
 * producing valid output and ran out of room, so the text is a fragment.
 *
 * The message is `bedrockService.BedrockModelTruncatedError`'s word for word,
 * because it ends up on the `design_prototypes` row either way: in process
 * `generateSinglePrototype` writes `err.message`, and on V2 it travels as the
 * terminal detail for `designPrototypeV2Harvest` to write. That class is not
 * imported because `bedrockService` records usage and would pull PostgreSQL
 * into the worker image.
 */
export class VisualModelTruncatedError extends Error {
  constructor(
    public readonly modelText: string,
    public readonly maxTokens: number,
  ) {
    super(
      `Model response was truncated at ${maxTokens} output tokens. `
        + `Increase BEDROCK_UI_MOCK_MAX_TOKENS or use a more concise prompt.`,
    );
    this.name = 'VisualModelTruncatedError';
  }
}

type SendableClient = Pick<BedrockRuntimeClient, 'send'>;

type RetrySleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Visual model execution was aborted');
  error.name = 'AbortError';
  return error;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal!));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isBedrockRetryable(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    statusCode?: number;
    $metadata?: { httpStatusCode?: number };
  } | undefined;
  if (!candidate) return false;
  if (
    candidate.name === 'ThrottlingException'
    || candidate.name === 'TooManyRequestsException'
  ) {
    return true;
  }
  const status =
    candidate.statusCode
    ?? candidate.$metadata?.httpStatusCode;
  return status === 429 || (
    typeof status === 'number'
    && status >= 500
    && status < 600
  );
}

/**
 * Mirrors `bedrockService.invokeModel`: the image block comes first and the
 * text second. That ordering is part of what produces today's output, so it
 * is kept rather than chosen. With no image the message stays a plain string,
 * which is what a reference-less in-process call sends.
 */
function buildContent(
  prompt: string,
  images: ReadonlyArray<VisualReferenceImage> = [],
): string | unknown[] {
  const present = images.filter((image) => image.base64);
  if (present.length === 0) return prompt;

  return [
    ...present.map((image) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.base64,
      },
    })),
    { type: 'text', text: prompt },
  ];
}

function buildStreamingContent(
  prompt: string,
  images: ReadonlyArray<VisualReferenceImage>,
): unknown[] {
  const content = buildContent(prompt, images);
  return typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content;
}

export function createBedrockVisualClient(options?: {
  client?: SendableClient;
  region?: string;
  now?: () => number;
  sleep?: RetrySleep;
  random?: () => number;
}): BedrockVisualClient {
  const client =
    options?.client ??
    new BedrockRuntimeClient({
      region: options?.region ?? process.env.AWS_REGION ?? 'us-east-1',
    });
  const now = options?.now ?? Date.now;
  const sleep = options?.sleep ?? sleepWithAbort;
  const random = options?.random ?? Math.random;

  return {
    async invokeModel(prompt, model, images, signal) {
      const command = new InvokeModelCommand({
        modelId: model.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: model.maxTokens,
          messages: [{ role: 'user', content: buildContent(prompt, images) }],
          // Only where the specification carries one: UI Lab's in-process
          // payload omits the key when the project set no temperature, and
          // the model's own default is not the worker's to choose.
          ...(model.temperature !== undefined
            ? { temperature: model.temperature }
            : {}),
        }),
      });

      const startedAt = now();
      const sendAttempt = async () => {
        if (signal?.aborted) throw abortError(signal);
        const controller = new AbortController();
        const abortForAttempt = (): void =>
          controller.abort(signal?.reason);
        signal?.addEventListener('abort', abortForAttempt, { once: true });
        const timer = setTimeout(() => controller.abort(), model.timeoutMs);
        try {
          return await (client as BedrockRuntimeClient).send(command, {
            abortSignal: controller.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw abortError(signal);
          if (controller.signal.aborted) {
            throw new Error(
              `Bedrock request timed out after ${Math.round(
                model.timeoutMs / 1000,
              )}s (model=${model.modelId})`,
            );
          }
          throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abortForAttempt);
        }
      };

      let response;
      for (
        let attempt = 1;
        attempt <= model.retry.maxAttempts;
        attempt += 1
      ) {
        try {
          response = await sendAttempt();
          break;
        } catch (error) {
          if (signal?.aborted) throw abortError(signal);
          if (
            !isBedrockRetryable(error)
            || attempt === model.retry.maxAttempts
          ) {
            throw error;
          }
          let delay =
            model.retry.initialBackoffMs
            * Math.pow(model.retry.backoffMultiplier, attempt - 1);
          if (model.retry.jitter) {
            delay *= 0.5 + random();
          }
          await sleep(delay, signal);
        }
      }
      if (!response) throw new Error('Bedrock returned no response');

      const decoded = JSON.parse(
        new TextDecoder().decode(response.body as Uint8Array),
      ) as {
        content?: Array<{ type: string; text?: string }>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const html = decoded.content?.[0]?.text ?? '';

      // Truncation is reported here and nowhere else — the fragment is
      // well-formed enough to upload and reads as a finished prototype once
      // it is on the row. `bedrockService.invokeModel` throws at the same
      // point for the same reason.
      if (decoded.stop_reason === 'max_tokens') {
        console.warn(
          `[aiRunsV2Worker/visual] Response truncated at max_tokens=${model.maxTokens} `
            + `(model=${model.modelId}). Output length: ${html.length} chars.`,
        );
        throw new VisualModelTruncatedError(html, model.maxTokens);
      }

      return {
        html,
        usage: {
          inputTokens: decoded.usage?.input_tokens ?? 0,
          outputTokens: decoded.usage?.output_tokens ?? 0,
        },
        durationMs: now() - startedAt,
      };
    },

    async invokeStreamingModel(prompt, model, images, onText, signal) {
      const command = new InvokeModelWithResponseStreamCommand({
        modelId: model.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: model.maxTokens,
          messages: [
            {
              role: 'user',
              content: buildStreamingContent(prompt, images),
            },
          ],
          ...(model.temperature !== undefined
            ? { temperature: model.temperature }
            : {}),
        }),
      });

      const startedAt = now();
      const sendAttempt = async () => {
        if (signal?.aborted) throw abortError(signal);
        const controller = new AbortController();
        const abortForAttempt = (): void =>
          controller.abort(signal?.reason);
        signal?.addEventListener('abort', abortForAttempt, { once: true });
        const timer = setTimeout(() => controller.abort(), model.timeoutMs);
        try {
          return await (client as BedrockRuntimeClient).send(command, {
            abortSignal: controller.signal,
          });
        } catch (error) {
          if (signal?.aborted) throw abortError(signal);
          throw error;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abortForAttempt);
        }
      };

      let response;
      for (
        let attempt = 1;
        attempt <= model.retry.maxAttempts;
        attempt += 1
      ) {
        try {
          response = await sendAttempt();
          break;
        } catch (error) {
          if (signal?.aborted) throw abortError(signal);
          if (
            !isBedrockRetryable(error)
            || attempt === model.retry.maxAttempts
          ) {
            throw error;
          }
          let delay =
            model.retry.initialBackoffMs
            * Math.pow(model.retry.backoffMultiplier, attempt - 1);
          if (model.retry.jitter) {
            delay *= 0.5 + random();
          }
          await sleep(delay, signal);
        }
      }
      if (!response) throw new Error('Bedrock returned no response');

      let html = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      const body = (
        response as {
          body?: AsyncIterable<{
            chunk?: { bytes?: Uint8Array };
          }>;
        }
      ).body;
      for await (const event of body ?? []) {
        if (!event.chunk?.bytes) continue;
        try {
          const parsed = JSON.parse(
            new TextDecoder().decode(event.chunk.bytes),
          ) as {
            type?: string;
            delta?: { type?: string; text?: string };
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            message?: {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
              };
            };
          };
          if (
            parsed.type === 'content_block_delta'
            && parsed.delta?.type === 'text_delta'
          ) {
            const text = parsed.delta.text ?? '';
            html += text;
            await onText(text);
          }
          const usage = parsed.message?.usage ?? parsed.usage;
          if (usage) {
            if (usage.input_tokens) inputTokens = usage.input_tokens;
            if (usage.output_tokens) outputTokens = usage.output_tokens;
            if (usage.cache_read_input_tokens) {
              cacheReadTokens = usage.cache_read_input_tokens;
            }
            if (usage.cache_creation_input_tokens) {
              cacheWriteTokens = usage.cache_creation_input_tokens;
            }
          }
        } catch {
          // Match the in-process UI Lab stream: malformed event chunks are skipped.
        }
      }

      return {
        html,
        usage: {
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        },
        durationMs: now() - startedAt,
      };
    },
  };
}
