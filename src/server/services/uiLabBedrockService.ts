import { resolveLocalSkillBundle, resolveRemoteSkillBundle, logBundleDiagnostics } from './foundationSkillResolverService';
import path from 'path';
import fs from 'fs';
const { existsSync, readFileSync } = fs;
import { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { retryWithBackoff } from '../utils/retry';
import {
  fetchExistingPageContext,
  getDesignSystemCatalog,
  getScreenInventory,
} from './designSystemService';
import { getMaxviewColorTokens, getApexColorTokens } from './designTokensService';
import { getFigmaReference } from './figmaReferenceService';
import { recordAiUsage, computeCost } from './aiUsageService';
import type { VisualModelSettings } from '../../shared/types/aiRunV2VisualSpec';
import {
  buildResolvedUiLabContextSection,
  buildResolvedUiLabPrompt,
  type ResolvedUiLabPromptInput,
} from './aiRunsV2Worker/uiLabPromptBuilder';

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

const UI_LAB_RETRY_MAX_ATTEMPTS = 3;
const UI_LAB_RETRY_INITIAL_BACKOFF_MS = 2_000;

/**
 * UI Lab's model settings: the project's values where it set them, this
 * lane's own defaults where it did not.
 *
 * Used by the streaming call below and by whatever admits a UI Lab run to the
 * V2 lane, so both land on one set of numbers. A worker holds no policy — it
 * has neither the project settings row nor the environment these defaults are
 * tuned by — and this lane's policy is not the prototype lane's: UI Lab runs
 * on a smaller ceiling, a shorter timeout, and a temperature the project can
 * set. Temperature stays off the object when the project set none, because
 * the payload omits the key in that case.
 */
export function resolveUiLabVisualModel(input: {
  modelId?: string | null;
  maxTokens?: number | null;
  timeoutMs?: number | null;
  temperature?: number | null;
}): VisualModelSettings {
  return {
    modelId: input.modelId ?? DEFAULT_UI_LAB_MODEL,
    maxTokens: input.maxTokens ?? DEFAULT_UI_LAB_MAX_TOKENS,
    timeoutMs: input.timeoutMs ?? DEFAULT_UI_LAB_TIMEOUT_MS,
    retry: {
      maxAttempts: UI_LAB_RETRY_MAX_ATTEMPTS,
      initialBackoffMs: UI_LAB_RETRY_INITIAL_BACKOFF_MS,
      backoffMultiplier: 2,
      jitter: true,
    },
    ...(input.temperature != null ? { temperature: input.temperature } : {}),
  };
}

const APEX_COMPONENT_INDEX_PATH = path.join(
  __dirname, '..', 'assets', 'apex-component-index.md',
);

/**
 * The APEX project name as configured in the environment.
 * Defaults to 'Apex' which matches the virtual project used throughout the app.
 */
function apexProjectName(): string {
  return (process.env.APEX_PROJECT_NAME ?? 'Apex').trim();
}

/** True when the request is being made in the context of the APEX project itself. */
function isApexProject(project?: string): boolean {
  if (!project) return false;
  return project.trim().toLowerCase() === apexProjectName().toLowerCase();
}

function loadApexComponentIndex(): string {
  try {
    if (existsSync(APEX_COMPONENT_INDEX_PATH)) {
      return readFileSync(APEX_COMPONENT_INDEX_PATH, 'utf-8').trim();
    }
  } catch { /* non-fatal */ }
  return '';
}

function isThrottleError(err: unknown): boolean {
  const e = err as { name?: string; statusCode?: number; $metadata?: { httpStatusCode?: number } } | undefined;
  if (!e) return false;
  const name = e.name ?? '';
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException') return true;
  const status = e.statusCode ?? e.$metadata?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

function loadLocalSkill(): string {
  // Pure local APEX adapter fallback (used when no uiLabSkillPath is configured)
  try {
    const bundle = resolveLocalSkillBundle('ui-lab');
    return bundle.notFound ? '' : bundle.content;
  } catch {
    return '';
  }
}

async function loadUiLabSkillContent(
  uiLabSkillPath?: string | null,
  skillRepo?: string | null,
  skillBranch?: string | null,
  skillProvider?: 'ado' | 'github' | null,
  project?: string | null,
): Promise<string> {
  if (uiLabSkillPath && skillRepo) {
    const bundle = await resolveRemoteSkillBundle(
      uiLabSkillPath,
      'ui-lab',
      { skillProvider: skillProvider ?? 'ado', skillRepo, skillBranch: skillBranch ?? 'main', project },
      loadLocalSkill(),
    );
    logBundleDiagnostics('ui-lab (remote)', bundle);
    return bundle.content;
  }
  // No configured path — use resolver with local APEX adapter as fallback
  const bundle = resolveLocalSkillBundle('ui-lab', loadLocalSkill());
  logBundleDiagnostics('ui-lab (local)', bundle);
  return bundle.content;
}

export async function resolveUiLabPromptInput(input: {
  userPrompt: string;
  targetRoute?: string | null;
  project?: string;
  uiLabSkillPath?: string | null;
  skillRepo?: string | null;
  skillBranch?: string | null;
  skillProvider?: 'ado' | 'github' | null;
}): Promise<ResolvedUiLabPromptInput> {
  const forApex = isApexProject(input.project);
  const skillMarkdown = await loadUiLabSkillContent(
    input.uiLabSkillPath,
    input.skillRepo,
    input.skillBranch,
    input.skillProvider,
    input.project,
  );
  let colorTokens = '';
  let componentIndex = '';
  let catalog: unknown;

  if (forApex) {
    try {
      colorTokens = getApexColorTokens();
    } catch { /* non-fatal */ }
    componentIndex = loadApexComponentIndex();
  } else {
    try {
      colorTokens = getMaxviewColorTokens();
    } catch {
      // non-fatal
    }
    try {
      catalog = await getDesignSystemCatalog();
    } catch {
      // non-fatal
    }
  }

  let screenInventory: unknown;
  try {
    screenInventory = await getScreenInventory();
  } catch {
    // non-fatal
  }

  let existingPageContext = '';
  if (input.targetRoute?.trim()) {
    try {
      existingPageContext = await fetchExistingPageContext(
        input.targetRoute,
        input.userPrompt,
      );
    } catch {
      // non-fatal
    }
  }

  return {
    userPrompt: input.userPrompt,
    targetRoute: input.targetRoute ?? null,
    designSystemName: forApex ? 'APEX' : 'MaxView',
    skillMarkdown,
    componentIndex,
    existingPageContext,
    catalog,
    screenInventory,
    colorTokens,
  };
}

function buildEditPrompt(
  userInstruction: string,
  currentHtml: string,
  selectedSelector?: string | null,
  selectedHtml?: string | null,
  contextSection?: string,
  designSystemName?: string,
): string {
  const dsName = designSystemName ?? 'MaxView';
  const scopeClause = selectedSelector && selectedHtml
    ? `Focus your changes on the element matching CSS selector \`${selectedSelector}\`:
\`\`\`html
${selectedHtml}
\`\`\`
Only change this element and its children unless the instruction explicitly requires structural changes elsewhere. Preserve all \`<!-- STATE:*:START/END -->\` markers and the complete surrounding HTML exactly.`
    : 'Apply the changes across the full design as appropriate. Preserve all `<!-- STATE:*:START/END -->` markers.';

  const ctx = contextSection ? `${contextSection}\n\n---\n\n` : '';

  return `You are an expert UI/UX designer and front-end engineer specializing in the ${dsName} design system. Edit the provided HTML prototype according to the instruction below.

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
- Maintain design system fidelity: ${dsName} colors, spacing, typography.
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
  /** Repo-relative path to a custom UI Lab SKILL.md (from project settings). */
  uiLabSkillPath?: string | null;
  /** Required when uiLabSkillPath is set — the skill repo to fetch from. */
  skillRepo?: string | null;
  skillBranch?: string | null;
  skillProvider?: 'ado' | 'github' | null;
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
  /** Repo-relative path to a custom UI Lab SKILL.md (from project settings). */
  uiLabSkillPath?: string | null;
  skillRepo?: string | null;
  skillBranch?: string | null;
  skillProvider?: 'ado' | 'github' | null;
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
        maxRetries: UI_LAB_RETRY_MAX_ATTEMPTS,
        initialDelay: UI_LAB_RETRY_INITIAL_BACKOFF_MS,
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
  const { modelId, maxTokens, timeoutMs } = resolveUiLabVisualModel(opts);

  let figmaBase64: string | undefined;
  try {
    const figmaRef = getFigmaReference();
    figmaBase64 = figmaRef.tablePageBase64 ?? undefined;
  } catch {
    // non-fatal
  }

  const promptInput = await resolveUiLabPromptInput({
    userPrompt: opts.prompt,
    targetRoute: opts.targetRoute,
    project: opts.project,
    uiLabSkillPath: opts.uiLabSkillPath,
    skillRepo: opts.skillRepo,
    skillBranch: opts.skillBranch,
    skillProvider: opts.skillProvider,
  });
  const prompt = buildResolvedUiLabPrompt(promptInput);

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
  const { modelId, maxTokens, timeoutMs } = resolveUiLabVisualModel(opts);

  const promptInput = await resolveUiLabPromptInput({
    userPrompt: opts.featureText ?? opts.instruction,
    targetRoute: opts.targetRoute,
    project: opts.project,
    uiLabSkillPath: opts.uiLabSkillPath,
    skillRepo: opts.skillRepo,
    skillBranch: opts.skillBranch,
    skillProvider: opts.skillProvider,
  });
  const contextSection = buildResolvedUiLabContextSection(promptInput);
  const prompt = buildEditPrompt(
    opts.instruction,
    opts.currentHtml,
    opts.selectedSelector,
    opts.selectedHtml,
    contextSection,
    promptInput.designSystemName,
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
