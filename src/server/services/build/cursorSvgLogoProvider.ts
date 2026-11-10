import { Agent, type ToolName } from '@cursor/sdk';
import type {
  LocalAgentOptions,
  McpServerConfig,
} from '@cursor/sdk/dist/cjs/options.js';
import sharp from 'sharp';
import { buildCursorModelSelection } from '../agentEffortResolver';
import { LogoProviderError, type LogoImageProvider } from './logoImageProvider';
import { sanitizeLogoSvg } from './logoSvgSanitizer';

const DEFAULT_LOGO_MODEL = 'composer-2.5';
const DEFAULT_TIMEOUT_MS = 60_000;

interface CursorLogoRuntime {
  generate(input: {
    prompt: string;
    modelId: string;
    signal: AbortSignal;
  }): Promise<string>;
}

export interface LogoModelEvent {
  type: string;
  text?: unknown;
  status?: string;
  message?:
    | string
    | { content?: ReadonlyArray<{ type?: string; text?: string }> };
}

interface LogoModelWait {
  status?: string;
  result?: unknown;
  error?: { message?: string };
}

/**
 * The fast interactive lane keeps the turn-end answer, which replaces any
 * partial assistant text. Logo generation reads the same two events.
 */
export function collectLogoModelText(
  events: readonly LogoModelEvent[],
  waitResult?: string | null
): string {
  let output = '';
  for (const event of events) {
    if (
      event.type === 'apex_turn_end' &&
      typeof event.text === 'string' &&
      event.text.trim()
    ) {
      return event.text;
    }
    if (event.type !== 'assistant' || typeof event.message === 'string') {
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text) output += block.text;
    }
  }
  if (!output.trim() && waitResult?.trim()) return waitResult;
  return output;
}

export function readLogoModelFailure(
  events: readonly LogoModelEvent[],
  waited?: LogoModelWait | null
): string | null {
  const waitMessage = waited?.error?.message?.trim();
  if (waitMessage) return waitMessage;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'status' || event.status !== 'ERROR') continue;
    return typeof event.message === 'string' && event.message.trim()
      ? event.message.trim()
      : 'Cursor could not generate logo options.';
  }
  if (waited?.status === 'error') {
    return 'Cursor could not generate logo options.';
  }
  return null;
}

export function isUnavailableLogoModel(message: string): boolean {
  return /blocked|unavailable|not available|does not exist|unknown model|not found|not supported/i.test(
    message
  );
}

function svgStringsFromJson(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as { svgs?: unknown };
    if (
      Array.isArray(parsed.svgs) &&
      parsed.svgs.every((item): item is string => typeof item === 'string')
    ) {
      return parsed.svgs;
    }
  } catch {
    return null;
  }
  return null;
}

export function extractSvgList(output: string): string[] {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const direct = svgStringsFromJson(candidate);
  if (direct) return direct;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const embedded = svgStringsFromJson(candidate.slice(start, end + 1));
    if (embedded) return embedded;
  }
  const raw = [...output.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)].map(
    (match) => match[0].trim()
  );
  if (raw.length > 0) return raw;
  throw new LogoProviderError(
    'The Cursor model did not return the expected SVG logo options.'
  );
}

function buildLogoPrompt(input: {
  applicationPrompt?: string;
  prompt: string;
  count: number;
  seed: number;
}): string {
  return [
    'Create distinct, polished vector logo options for a web application.',
    `Return exactly ${input.count} options as one JSON object: {"svgs":["<svg>...</svg>"]}.`,
    'Return JSON only. Do not use Markdown.',
    'Each SVG must use viewBox="0 0 512 512", work at 32px, and have a transparent background.',
    'Use only these SVG elements: svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan.',
    'Do not use scripts, styles, images, links, external references, filters, masks, clip paths, definitions, or embedded data.',
    'Keep each option visually different and limit the palette to four solid colors.',
    `Variation seed: ${input.seed}.`,
    '',
    'Application request:',
    (
      input.applicationPrompt ?? 'No separate application title was provided.'
    ).slice(0, 2_000),
    '',
    'Logo request:',
    input.prompt.slice(0, 2_000),
  ].join('\n');
}

async function runLogoModel(input: {
  apiKey: string;
  prompt: string;
  modelId: string;
  signal: AbortSignal;
}): Promise<string> {
  const local = {
    cwd: process.cwd(),
    settingSources: [],
    enableAgentRetries: false,
  } satisfies LocalAgentOptions;
  const agent = await Agent.create({
    apiKey: input.apiKey,
    model: buildCursorModelSelection(input.modelId),
    tools: [] as ToolName[],
    mode: 'agent',
    local,
    mcpServers: {} as Record<string, McpServerConfig>,
  });
  try {
    const run = await agent.send(input.prompt);
    const cancel = () => {
      void run.cancel().catch(() => undefined);
    };
    input.signal.addEventListener('abort', cancel, { once: true });
    const events: LogoModelEvent[] = [];
    let waited: LogoModelWait | null = null;
    try {
      const readable = run as {
        supports(capability: string): boolean;
        stream(): AsyncIterable<LogoModelEvent>;
        wait?(): Promise<LogoModelWait>;
      };
      if (readable.supports('stream')) {
        for await (const event of readable.stream()) events.push(event);
      }
      if (readable.wait) {
        waited = await Promise.race([
          readable.wait().catch(() => null),
          new Promise<null>((resolve) => {
            if (input.signal.aborted) resolve(null);
            else {
              input.signal.addEventListener('abort', () => resolve(null), {
                once: true,
              });
            }
          }),
        ]);
      }
    } finally {
      input.signal.removeEventListener('abort', cancel);
    }
    const failure = readLogoModelFailure(events, waited);
    if (failure) throw new LogoProviderError(failure);
    const waitResult = typeof waited?.result === 'string' ? waited.result : null;
    return collectLogoModelText(events, waitResult);
  } finally {
    await agent[Symbol.asyncDispose]().catch(() => undefined);
  }
}

const cursorRuntime: CursorLogoRuntime = {
  async generate(input) {
    const apiKey = process.env.CURSOR_API_KEY?.trim();
    if (!apiKey) {
      throw new LogoProviderError(
        'CURSOR_API_KEY is required to generate logos.'
      );
    }
    try {
      return await runLogoModel({ ...input, apiKey });
    } catch (error) {
      if (
        input.modelId === DEFAULT_LOGO_MODEL ||
        !(error instanceof LogoProviderError) ||
        !isUnavailableLogoModel(error.message)
      ) {
        throw error;
      }
      return runLogoModel({
        ...input,
        apiKey,
        modelId: DEFAULT_LOGO_MODEL,
      });
    }
  },
};

export function createCursorSvgLogoProvider(
  options: {
    runtime?: CursorLogoRuntime;
    modelId?: string;
    timeoutMs?: number;
    rasterize?: (svg: string) => Promise<Buffer>;
  } = {}
): LogoImageProvider {
  const runtime = options.runtime ?? cursorRuntime;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rasterize =
    options.rasterize ??
    ((svg: string) =>
      sharp(Buffer.from(svg, 'utf8'))
        .resize(512, 512, { fit: 'contain' })
        .png()
        .toBuffer());

  return {
    id: 'cursor_svg',
    async generate(input) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () =>
          controller.abort(
            new LogoProviderError('Cursor logo generation timed out.')
          ),
        timeoutMs
      );
      try {
        const output = await runtime.generate({
          prompt: buildLogoPrompt(input),
          modelId: input.modelId ?? options.modelId ?? DEFAULT_LOGO_MODEL,
          signal: controller.signal,
        });
        const svgs = extractSvgList(output);
        if (svgs.length !== input.count) {
          throw new LogoProviderError(
            `The Cursor model returned ${svgs.length} logo options instead of ${input.count}.`
          );
        }
        return Promise.all(svgs.map((svg) => rasterize(sanitizeLogoSvg(svg))));
      } catch (error) {
        if (error instanceof LogoProviderError) throw error;
        if (controller.signal.aborted) {
          throw new LogoProviderError('Cursor logo generation timed out.');
        }
        throw new LogoProviderError('Cursor could not generate logo options.');
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
