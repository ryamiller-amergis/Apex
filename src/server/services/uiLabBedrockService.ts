import path from 'path';
import fs from 'fs';
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { retryWithBackoff } from '../utils/retry';
import { getDesignSystemCatalog, getScreenInventory } from './designSystemService';
import { getMaxviewColorTokens } from './designTokensService';
import { getFigmaReference } from './figmaReferenceService';
import { recordAiUsage, computeCost } from './aiUsageService';

/**
 * Cross-region inference profiles (us.anthropic.* model IDs) must be invoked
 * through us-east-1. If AWS_REGION is set to another region in the environment
 * (e.g. us-east-2), the us.* profile endpoint won't resolve. We always
 * override to us-east-1 for these profiles; a BEDROCK_UI_LAB_REGION env var
 * can override this when deploying in a non-standard setup.
 */
function resolveBedrockRegion(modelId: string): string {
  const explicit = process.env.BEDROCK_UI_LAB_REGION;
  if (explicit) return explicit;
  // Cross-region inference profile IDs start with a geo prefix ("us.", "eu.", "ap.")
  if (/^(us|eu|ap)\./.test(modelId)) return 'us-east-1';
  return process.env.AWS_REGION ?? 'us-east-1';
}

function makeClient(modelId: string): BedrockRuntimeClient {
  return new BedrockRuntimeClient({ region: resolveBedrockRegion(modelId) });
}

const DEFAULT_UI_LAB_MODEL =
  process.env.BEDROCK_UI_LAB_MODEL_ID ??
  process.env.BEDROCK_UI_MOCK_MODEL_ID ??
  process.env.BEDROCK_MODEL_ID ??
  'us.anthropic.claude-sonnet-4-6';

const DEFAULT_UI_LAB_MAX_TOKENS = (() => {
  const raw = process.env.BEDROCK_UI_LAB_MAX_TOKENS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16000;
})();

const DEFAULT_UI_LAB_TIMEOUT_MS = (() => {
  const raw = process.env.BEDROCK_UI_LAB_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000;
})();

const SKILL_PATH = path.join(process.cwd(), '.cursor', 'skills', 'ui-lab', 'SKILL.md');

function isThrottleError(err: unknown): boolean {
  const e = err as { name?: string; statusCode?: number; $metadata?: { httpStatusCode?: number } } | undefined;
  if (!e) return false;
  const name = e.name ?? '';
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException') return true;
  const status = e.statusCode ?? e.$metadata?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

function loadLocalSkill(): string {
  try {
    return fs.readFileSync(SKILL_PATH, 'utf-8');
  } catch {
    return '';
  }
}

function buildCatalogSection(): string {
  const catalog = (() => {
    try {
      return { routes: [] as string[], componentNames: [] as string[], uiKnowledgeBase: '', tokensCss: '', componentDescriptions: {} as Record<string, string> };
    } catch {
      return { routes: [], componentNames: [], uiKnowledgeBase: '', tokensCss: '', componentDescriptions: {} };
    }
  })();

  return catalog.uiKnowledgeBase ?? '';
}

async function buildContextSection(
  targetRoute?: string | null,
  featureText?: string,
): Promise<string> {
  const parts: string[] = [];

  const skillMarkdown = loadLocalSkill();
  if (skillMarkdown.trim()) {
    parts.push(`## UI Lab Design System Standards\n\n${skillMarkdown.trim()}`);
  }

  try {
    const colorTokens = getMaxviewColorTokens();
    if (colorTokens.trim()) {
      parts.push(`## MaxView Color Tokens\n\n${colorTokens.trim()}`);
    }
  } catch {
    // non-fatal — colors unavailable
  }

  try {
    const catalog = await getDesignSystemCatalog();
    const ctxParts: string[] = [];

    if (catalog.uiKnowledgeBase?.trim()) {
      ctxParts.push(`### Existing screens — detailed descriptions\n\n${catalog.uiKnowledgeBase.trim()}`);
    }

    if (catalog.routes?.length) {
      ctxParts.push(`### Application routes\n\n${catalog.routes.join('\n')}`);
    }

    if (catalog.tokensCss?.trim()) {
      ctxParts.push(`### CSS custom properties (design tokens)\n\n\`\`\`css\n${catalog.tokensCss.trim()}\n\`\`\``);
    }

    const compNames = (catalog.componentNames ?? []).slice(0, 50);
    if (compNames.length) {
      const compLines = compNames.map((name) => {
        const desc = catalog.componentDescriptions?.[name];
        return desc ? `- **${name}**: ${desc}` : `- ${name}`;
      });
      ctxParts.push(`### Available MaxView components\n\n${compLines.join('\n')}`);
    }

    if (ctxParts.length) {
      parts.push(`## MaxView Design System Catalog\n\n${ctxParts.join('\n\n')}`);
    }
  } catch {
    // non-fatal — catalog unavailable
  }

  try {
    const inventory = await getScreenInventory();
    if (inventory.length) {
      // Keep the target route's row from being truncated by the 30-row cap by
      // ordering any rows matching the target route first.
      const normTarget = targetRoute
        ? targetRoute.trim().toLowerCase().replace(/^\//, '').split(/[?#]/)[0]
        : '';
      const isTarget = (r: { route: string }) =>
        normTarget.length > 0 &&
        r.route
          .split(',')
          .some((seg) => seg.trim().toLowerCase().replace(/^\//, '').split(/[?#]/)[0].includes(normTarget));
      const ordered = normTarget
        ? [...inventory.filter(isTarget), ...inventory.filter((r) => !isTarget(r))]
        : inventory;
      const rows = ordered
        .slice(0, 30)
        .map((r) => `- **${r.route}** — ${r.purpose ?? ''}${r.userTypes?.length ? ` (${r.userTypes.join(', ')})` : ''}`)
        .join('\n');
      parts.push(`## Screen Inventory (existing pages)\n\n${rows}`);
    }
  } catch {
    // non-fatal
  }

  // EXTEND mode: when a target route is set, pull the ACTUAL existing page source
  // (page component + relevant child components, keyword-guided) so the generated
  // design faithfully extends the real page rather than approximating from a
  // screenshot. Non-fatal — falls back to the catalog-only context on any failure.
  if (targetRoute?.trim()) {
    try {
      const { fetchExistingPageContext } = await import('./designSystemService');
      const pageContext = await fetchExistingPageContext(targetRoute, featureText);
      if (pageContext.trim()) {
        parts.push(
          `## Existing page source — extend this (ground truth)\n\n` +
            `The following is the real source of the page at \`${targetRoute}\` and its ` +
            `relevant child components. Reproduce its actual layout, columns, controls, and ` +
            `data shape, and add the requested new behavior INTO this structure — do not ` +
            `invent a different layout or let the brief override the existing structure.\n\n` +
            pageContext.trim(),
        );
      }
    } catch {
      // non-fatal — existing-page source unavailable
    }
  }

  return parts.join('\n\n---\n\n');
}

function buildGenerationPrompt(
  userPrompt: string,
  contextSection: string,
  targetRoute?: string | null,
  figmaBase64?: string,
): string {
  const routeClause = targetRoute
    ? `The UI should be designed for the route: \`${targetRoute}\`. Study the existing page context from the design system catalog and match the surrounding layout/navigation shell.`
    : 'This is a standalone new UI — design an appropriate layout and navigation shell.';

  return `You are an expert UI/UX designer and front-end engineer specializing in the MaxView design system. Generate a complete, self-contained, interactive HTML prototype that exactly follows the MaxView design system tokens, spacing, typography, and component usage rules defined below.

${contextSection}

---

## Your task

${userPrompt}

${routeClause}

---

## Critical output requirements

### 1. Design system fidelity
- Use ONLY color values from the MaxView Color Tokens above — no invented hex values.
- Use ONLY the spacing scale (multiples of 4px, base 8px grid).
- Use Roboto font: add \`<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">\` in <head>.
- Follow the component usage rules exactly (button variants, form patterns, elevation).

### 2. Four required UI states
Include all four states with these exact HTML comment markers:

\`\`\`
<!-- STATE:DEFAULT:START -->
  ... fully populated/interactive default state ...
<!-- STATE:DEFAULT:END -->

<!-- STATE:EMPTY:START -->
  ... empty/zero-data state with helpful message and CTA ...
<!-- STATE:EMPTY:END -->

<!-- STATE:ERROR:START -->
  ... error/failure state with message and retry action ...
<!-- STATE:ERROR:END -->

<!-- STATE:LOADING:START -->
  ... skeleton/spinner loading state ...
<!-- STATE:LOADING:END -->
\`\`\`

Only DEFAULT is visible on load. Include a small state-switcher control (top-right, subtle) to toggle between states for review.

### 3. Self-contained HTML
- One complete <html> document.
- All CSS inline in <style> tags — no external CSS imports except Google Fonts.
- All JS inline in <script> tags — no external JS (no React, no framework).
- No calls to external APIs, no fetch(), no XMLHttpRequest.
- Fully functional interactive prototype: clicks, hovers, form interactions work.
- Responsive: mobile-first, works at 375px and 1440px width.

### 4. Realistic content
- Use realistic, plausible placeholder content (not "Lorem ipsum").
- Use realistic user names, dates, data values appropriate to the described feature.

### 5. Accessibility baseline
- All images have non-empty alt attributes.
- All icon-only buttons have aria-label.
- Form inputs have associated labels.
- Focus ring visible on all interactive elements.

---

Output ONLY the complete HTML — no markdown fences, no explanation, no preamble. Start with \`<!DOCTYPE html>\` and end with \`</html>\`.`;
}

function buildEditPrompt(
  userInstruction: string,
  currentHtml: string,
  selectedSelector?: string | null,
  selectedHtml?: string | null,
  contextSection?: string,
): string {
  const scopeClause = selectedSelector && selectedHtml
    ? `Focus your changes on the element matching CSS selector \`${selectedSelector}\`:
\`\`\`html
${selectedHtml}
\`\`\`
Only change this element and its children unless the instruction explicitly requires structural changes elsewhere. Preserve all \`<!-- STATE:*:START/END -->\` markers and the complete surrounding HTML exactly.`
    : 'Apply the changes across the full design as appropriate. Preserve all \`<!-- STATE:*:START/END -->\` markers.';

  const ctx = contextSection ? `${contextSection}\n\n---\n\n` : '';

  return `You are an expert UI/UX designer and front-end engineer specializing in the MaxView design system. Edit the provided HTML prototype according to the instruction below.

${ctx}## Instruction

${userInstruction}

## Scope

${scopeClause}

## Current HTML

\`\`\`html
${currentHtml}
\`\`\`

---

## Rules
- Output the COMPLETE updated HTML — never omit any part.
- Maintain design system fidelity: MaxView colors, spacing, typography.
- Keep all four \`<!-- STATE:*:START/END -->\` comment markers intact.
- Do NOT add external scripts or API calls.
- Do NOT change unrelated parts of the UI.

Output ONLY the complete updated HTML — no markdown fences, no explanation. Start with \`<!DOCTYPE html>\` and end with \`</html>\`.`;
}

export interface UiLabGenerateOptions {
  prompt: string;
  targetRoute?: string | null;
  modelId?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  onToken: (chunk: string) => void;
  project?: string;
  userId?: string;
}

export interface UiLabEditOptions {
  currentHtml: string;
  instruction: string;
  selectedSelector?: string | null;
  selectedHtml?: string | null;
  targetRoute?: string | null;
  featureText?: string | null;
  modelId?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  onToken: (chunk: string) => void;
  project?: string;
  userId?: string;
}

async function invokeStreaming(
  prompt: string,
  modelId: string,
  maxTokens: number,
  timeoutMs: number,
  temperature: number | undefined,
  onToken: (chunk: string) => void,
  figmaBase64?: string,
  project?: string,
  userId?: string,
): Promise<string> {
  const client = makeClient(modelId);
  const content: Array<Record<string, unknown>> = [];

  if (figmaBase64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: figmaBase64 },
    });
  }

  content.push({ type: 'text', text: prompt });

  const payload: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };

  if (temperature !== undefined) {
    payload.temperature = temperature;
  }

  const command = new InvokeModelWithResponseStreamCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let fullText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  try {
    const response = await retryWithBackoff(
      () => client.send(command, { abortSignal: controller.signal }),
      {
        maxRetries: 3,
        initialDelay: 2000,
        jitter: true,
        shouldRetry: isThrottleError,
      },
    );

    for await (const event of response.body ?? []) {
      if (event.chunk?.bytes) {
        const decoded = new TextDecoder().decode(event.chunk.bytes);
        try {
          const parsed = JSON.parse(decoded) as {
            type?: string;
            // content_block_delta
            delta?: { type?: string; text?: string };
            // message_delta has usage at top level
            usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
            // message_start has usage nested under message
            message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
          };

          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            const text = parsed.delta.text ?? '';
            fullText += text;
            onToken(text);
          }

          // message_start: input token count under parsed.message.usage
          const startUsage = parsed.message?.usage;
          if (startUsage) {
            if (startUsage.input_tokens) inputTokens = startUsage.input_tokens;
            if (startUsage.cache_read_input_tokens) cacheReadTokens = startUsage.cache_read_input_tokens;
            if (startUsage.cache_creation_input_tokens) cacheWriteTokens = startUsage.cache_creation_input_tokens;
          }

          // message_delta: output token count under parsed.usage
          const deltaUsage = parsed.usage;
          if (deltaUsage) {
            if (deltaUsage.output_tokens) outputTokens = deltaUsage.output_tokens;
            if (deltaUsage.input_tokens) inputTokens = deltaUsage.input_tokens;
            if (deltaUsage.cache_read_input_tokens) cacheReadTokens = deltaUsage.cache_read_input_tokens;
            if (deltaUsage.cache_creation_input_tokens) cacheWriteTokens = deltaUsage.cache_creation_input_tokens;
          }
        } catch {
          // skip malformed event chunks
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  // Record exact usage (fire-and-forget)
  // If streaming didn't emit usage events (some model versions), fall back to
  // character-length estimation so the interaction is still recorded.
  const hasExactTokens = inputTokens > 0 || outputTokens > 0;
  const recordInputTokens = hasExactTokens ? inputTokens : Math.ceil(prompt.length / 4);
  const recordOutputTokens = hasExactTokens ? outputTokens : Math.ceil(fullText.length / 4);
  const tokenSource = hasExactTokens ? 'exact' as const : 'estimated' as const;
  const costSource = hasExactTokens ? 'computed' as const : 'estimated' as const;

  computeCost({
    provider: 'bedrock',
    modelId,
    inputTokens: recordInputTokens,
    outputTokens: recordOutputTokens,
    cacheReadTokens: hasExactTokens ? cacheReadTokens : 0,
    cacheWriteTokens: hasExactTokens ? cacheWriteTokens : 0,
  })
    .then((costUsd) => recordAiUsage({
      provider: 'bedrock',
      modelId,
      feature: 'ui-lab',
      project: project ?? 'unknown',
      userId,
      inputTokens: recordInputTokens,
      outputTokens: recordOutputTokens,
      cacheReadTokens: hasExactTokens ? cacheReadTokens : 0,
      cacheWriteTokens: hasExactTokens ? cacheWriteTokens : 0,
      tokenSource,
      costUsd,
      costSource,
      status: 'success',
    }))
    .catch(() => {});

  return fullText;
}

export async function generateUiLabDesign(opts: UiLabGenerateOptions): Promise<string> {
  const modelId = opts.modelId ?? DEFAULT_UI_LAB_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_UI_LAB_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_UI_LAB_TIMEOUT_MS;

  let figmaBase64: string | undefined;
  try {
    const figmaRef = getFigmaReference();
    figmaBase64 = figmaRef.tablePageBase64 ?? undefined;
  } catch {
    // non-fatal
  }

  const contextSection = await buildContextSection(opts.targetRoute, opts.prompt);
  const prompt = buildGenerationPrompt(opts.prompt, contextSection, opts.targetRoute, figmaBase64);

  return invokeStreaming(
    prompt,
    modelId,
    maxTokens,
    timeoutMs,
    opts.temperature,
    opts.onToken,
    figmaBase64,
    opts.project,
    opts.userId,
  );
}

export async function editUiLabDesign(opts: UiLabEditOptions): Promise<string> {
  const modelId = opts.modelId ?? DEFAULT_UI_LAB_MODEL;
  const maxTokens = opts.maxTokens ?? DEFAULT_UI_LAB_MAX_TOKENS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_UI_LAB_TIMEOUT_MS;

  const contextSection = await buildContextSection(
    opts.targetRoute,
    opts.featureText ?? undefined,
  );
  const prompt = buildEditPrompt(
    opts.instruction,
    opts.currentHtml,
    opts.selectedSelector,
    opts.selectedHtml,
    contextSection,
  );

  return invokeStreaming(prompt, modelId, maxTokens, timeoutMs, opts.temperature, opts.onToken, undefined, opts.project, opts.userId);
}

/** Strip markdown fences that models sometimes wrap their HTML output in */
export function extractHtml(raw: string): string {
  const stripped = raw
    .replace(/^```html\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  return stripped.startsWith('<!DOCTYPE') || stripped.startsWith('<html') ? stripped : raw.trim();
}
