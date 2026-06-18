import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockClient, ListInferenceProfilesCommand } from '@aws-sdk/client-bedrock';
import https from 'https';
import { retryWithBackoff } from '../utils/retry';
import { getFigmaReference } from './figmaReferenceService';
import { getMaxviewColorTokens } from './designTokensService';
import type { DesignSystemCatalog } from './designSystemService';
import type { ScreenInventoryRoute } from '../../shared/types/designSystem';
import type { UiSurfacePlan, PbiContribution, UiLayoutPattern, PbiContributionType } from '../../shared/types/backlog';
import type { DesignPlanFeature } from '../../shared/types/designPlan';
import { DESIGN_PROTOTYPE_STATE_NAMES, type DesignPrototypeStateName } from '../../shared/types/designPrototype';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
});

const controlPlaneClient = new BedrockClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
});

/**
 * Hard wall-clock cap for a single Bedrock InvokeModel call. Prototype/mock
 * generations are large (high max_tokens); a stalled connection would otherwise
 * hang indefinitely and leave the generation row stuck. On timeout we abort the
 * request so callers fail fast and transition to a retryable error state.
 * Override via BEDROCK_INVOKE_TIMEOUT_MS (default 8 minutes).
 */
const MODEL_INVOKE_TIMEOUT_MS = (() => {
  const raw = process.env.BEDROCK_INVOKE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 12 * 60_000;
})();

/** Max attempts (incl. the first) when Bedrock throttles a model invocation. */
const MODEL_INVOKE_MAX_ATTEMPTS = (() => {
  const raw = process.env.BEDROCK_INVOKE_MAX_ATTEMPTS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
})();

/**
 * Retry only on throttling/rate-limit and transient 5xx — NOT on the abort
 * timeout (that means the model is genuinely too slow, so retrying wastes time)
 * and NOT on truncation (a deterministic max-tokens failure).
 */
function isBedrockThrottleError(err: unknown): boolean {
  const e = err as { name?: string; statusCode?: number; $metadata?: { httpStatusCode?: number } } | undefined;
  if (!e) return false;
  const name = e.name ?? '';
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException') return true;
  const status = e.statusCode ?? e.$metadata?.httpStatusCode;
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Model used specifically for UI/UX mock generation. Falls back to the default
 * MODEL_ID if BEDROCK_UI_MOCK_MODEL_ID is not set, so existing deployments
 * keep their current behavior unless they opt in to a different model.
 */
const UI_MOCK_MODEL_ID = process.env.BEDROCK_UI_MOCK_MODEL_ID ?? MODEL_ID;

/**
 * Max output tokens for UI mock generation. Bigger/newer models (Sonnet 4.6,
 * Opus 4.7) produce much longer HTML+JSON responses than Haiku 4.5, and the
 * default 4096 cap was truncating them mid-output, causing JSON parse failures.
 * 32K covers Opus 4.7 design prototype output comfortably; override via env var
 * if you observe truncated-JSON errors with particularly large mocks.
 */
const UI_MOCK_MAX_TOKENS = (() => {
  const raw = process.env.BEDROCK_UI_MOCK_MAX_TOKENS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32000;
})();

/** Default max-tokens used by PRD Apex Review when no project-level override is set. */
export const PRD_REVIEW_DEFAULT_MAX_TOKENS = 16000;

/**
 * Curated list of Bedrock models available for selection in the admin UI.
 * IDs use the cross-region inference prefix (us.*) which works in us-east-1.
 */
export const AVAILABLE_BEDROCK_MODELS: Array<{ id: string; label: string }> = [
  // Claude 4.8 / 4.6 generation (latest)
  { id: 'us.anthropic.claude-opus-4-8', label: 'Claude Opus 4.8 (most capable)' },
  { id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced, 1M ctx)' },
  { id: 'us.anthropic.claude-opus-4-6-v1', label: 'Claude Opus 4.6 (highly capable)' },
  // Claude 4.5 generation
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5 (fast, economical)' },
  { id: 'us.anthropic.claude-sonnet-4-5-20251001-v1:0', label: 'Claude Sonnet 4.5 (balanced)' },
  { id: 'us.anthropic.claude-opus-4-5-20251001-v1:0', label: 'Claude Opus 4.5 (capable)' },
  // Claude 3.5 generation
  { id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0', label: 'Claude 3.5 Haiku (fast, economical)' },
  { id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', label: 'Claude 3.5 Sonnet v2 (balanced)' },
];

/* ── Dynamic Bedrock model listing ──────────────────────────────────────────
 * Fetches active SYSTEM_DEFINED cross-region inference profiles from the
 * Bedrock control plane, filtered to Anthropic US-geo profiles.
 * Falls back to AVAILABLE_BEDROCK_MODELS when AWS credentials are absent
 * (local dev without AWS config) or the API call fails for any reason.
 * Results are cached for 1 hour so the UI endpoint stays fast.
 * ─────────────────────────────────────────────────────────────────────────*/

interface BedrockModelOption {
  id: string;
  label: string;
}

let _cachedModels: BedrockModelOption[] | null = null;
let _cacheExpiry = 0;
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function formatInferenceProfileLabel(name: string): string {
  // "US Anthropic Claude Sonnet 4.6" → "Claude Sonnet 4.6"
  // "US Claude Opus 4.1"             → "Claude Opus 4.1"
  return name.replace(/^(US|EU|AP|AU|JP|Global)\s+(Anthropic\s+)?/i, '').trim();
}

export async function listAvailableBedrockModels(): Promise<BedrockModelOption[]> {
  if (_cachedModels && Date.now() < _cacheExpiry) {
    return _cachedModels;
  }

  // Skip the API call in local dev when no AWS credentials are configured.
  if (!process.env.AWS_ACCESS_KEY_ID) {
    return AVAILABLE_BEDROCK_MODELS;
  }

  try {
    const allProfiles: BedrockModelOption[] = [];
    let nextToken: string | undefined;

    do {
      const resp = await controlPlaneClient.send(
        new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', nextToken }),
      );
      nextToken = resp.nextToken ?? undefined;
      for (const p of resp.inferenceProfileSummaries ?? []) {
        if (
          p.status === 'ACTIVE' &&
          p.inferenceProfileId?.startsWith('us.anthropic.')
        ) {
          allProfiles.push({
            id: p.inferenceProfileId,
            label: p.inferenceProfileName
              ? formatInferenceProfileLabel(p.inferenceProfileName)
              : p.inferenceProfileId,
          });
        }
      }
    } while (nextToken);

    if (allProfiles.length > 0) {
      // Sort newest/most-capable first: Opus before Sonnet before Haiku, higher version first.
      allProfiles.sort((a, b) => {
        const tier = (id: string) =>
          id.includes('opus') ? 0 : id.includes('sonnet') ? 1 : 2;
        const tierDiff = tier(a.id) - tier(b.id);
        if (tierDiff !== 0) return tierDiff;
        // Within the same tier, sort descending by ID string (newer versions sort later alphabetically).
        return b.id.localeCompare(a.id);
      });
      _cachedModels = allProfiles;
      _cacheExpiry = Date.now() + MODEL_CACHE_TTL_MS;
      return allProfiles;
    }
  } catch (err) {
    console.warn('[bedrockService] listAvailableBedrockModels failed, using fallback list:', err);
  }

  return AVAILABLE_BEDROCK_MODELS;
}

/* ── SDLC skill content cache ─────────────────────────────── */

const SKILL_REPO = 'MaxView';
const SKILL_PROJECT = 'MaxView';
const SKILL_PATHS = [
  '/.cursor/skills/sdlc-backlog',
  '/.cursor/skills/sdlc-backlog/SKILL.md',
  '/.cursor/skills/sdlc-backlog/README.md',
];

interface SkillCache {
  content: string;
  fetchedAt: number;
}

let skillCache: SkillCache | null = null;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function fetchRawFileFromADO(orgUrl: string, pat: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const token = Buffer.from(`:${pat}`).toString('base64');
    const encodedPath = encodeURIComponent(path);
    const apiUrl = new URL(
      `${orgUrl}/${SKILL_PROJECT}/_apis/git/repositories/${SKILL_REPO}/items?path=${encodedPath}&api-version=7.1&$format=text`
    );

    const options: https.RequestOptions = {
      hostname: apiUrl.hostname,
      path: apiUrl.pathname + apiUrl.search,
      method: 'GET',
      headers: {
        Authorization: `Basic ${token}`,
        Accept: 'text/plain',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`ADO returned ${res.statusCode} for path ${path}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching skill file at ${path}`));
    });
    req.end();
  });
}

async function loadSkillContent(): Promise<string> {
  const now = Date.now();
  if (skillCache && now - skillCache.fetchedAt < CACHE_TTL_MS) {
    return skillCache.content;
  }

  const orgUrl = process.env.ADO_ORG;
  const pat = process.env.ADO_PAT;

  if (!orgUrl || !pat) {
    console.warn('[bedrockService] ADO_ORG or ADO_PAT not set — skipping SDLC skill fetch');
    return '';
  }

  for (const path of SKILL_PATHS) {
    try {
      const content = await fetchRawFileFromADO(orgUrl, pat, path);
      if (content.trim()) {
        skillCache = { content, fetchedAt: now };
        console.log(`[bedrockService] Loaded SDLC skill from ADO path: ${path} (${content.length} chars)`);
        return content;
      }
    } catch (err: any) {
      console.warn(`[bedrockService] Could not fetch skill at ${path}: ${err.message}`);
    }
  }

  console.warn('[bedrockService] SDLC skill file not found in any tried path — using built-in format rules');
  return '';
}

/* ── Public types ─────────────────────────────────────────── */

export interface GenerateFeatureInput {
  epicTitle: string;
  epicDescription?: string;
  epicTags?: string[];
  existingFeatures: Array<{
    title: string;
    description?: string;
    priority?: string;
    confidence?: string;
    tags?: string[];
  }>;
  userRequest: string;
}

import type { ClarificationQuestion, ClarificationAnswer, ClarificationResponses } from '../../shared/types/backlog';
export type { ClarificationQuestion, ClarificationAnswer, ClarificationResponses };

export interface GeneratedFeatureData {
  title: string;
  description: string;
  priority: string;
  confidence: string;
  tags: string[];
  /** @deprecated Use businessClarifications / uiUxClarifications */
  clarificationNeeded?: string;
  businessClarifications?: ClarificationQuestion[];
  uiUxClarifications?: ClarificationQuestion[];
}

export interface GeneratedFeatureWithPBIs {
  feature: GeneratedFeatureData;
  pbis: GeneratedPBIData[];
}

export interface GeneratePBIInput {
  featureTitle: string;
  featureDescription?: string;
  featureTags?: string[];
  existingPBIs: Array<{
    title: string;
    description?: string;
    acceptanceCriteria?: string[];
    priority?: string;
    confidence?: string;
    tags?: string[];
  }>;
  userRequest: string;
}

export interface GeneratedPBIData {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: string;
  confidence: string;
  tags: string[];
}

/* ── JSON extraction helper ───────────────────────────────── */

/**
 * Try several strategies to pull a JSON object out of a model response.
 * Models sometimes omit the language tag, use single backticks, or return
 * bare JSON with no fences at all.
 */
/** Thrown when the model returns plain text instead of the expected JSON. */
export class BedrockModelRefusalError extends Error {
  constructor(public readonly modelText: string) {
    super(modelText);
    this.name = 'BedrockModelRefusalError';
  }
}

function extractJson(text: string, label: string): string {
  // 1. Fenced block with ```json … ```
  const fencedJson = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (fencedJson) return fencedJson[1].trim();

  // 2. Fenced block with no language tag ``` … ```
  const fencedPlain = text.match(/```\s*([\s\S]*?)\s*```/);
  if (fencedPlain) {
    const candidate = fencedPlain[1].trim();
    if (candidate.startsWith('{') || candidate.startsWith('[')) return candidate;
  }

  // 3. First top-level JSON object in the text
  const bare = text.match(/(\{[\s\S]*\})/);
  if (bare) return bare[1].trim();

  // Model returned plain text (clarification request, refusal, etc.) — surface it directly.
  console.warn(`[bedrockService] ${label} — model returned non-JSON response:\n${text}`);
  throw new BedrockModelRefusalError(text.trim());
}

/* ── Main generation function ─────────────────────────────── */

export async function generatePBIFromBedrock(
  input: GeneratePBIInput
): Promise<GeneratedPBIData> {
  const skillContent = await loadSkillContent();
  const prompt = buildPrompt(input, skillContent);

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await client.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = body.content[0]?.text ?? '';
  const parsed = JSON.parse(extractJson(text, 'PBI')) as GeneratedPBIData;

  return {
    title: parsed.title ?? '',
    description: parsed.description ?? '',
    acceptanceCriteria: Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria
      : [],
    priority: parsed.priority ?? 'Medium',
    confidence: parsed.confidence ?? 'Medium',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
  };
}

/* ── Feature generation ───────────────────────────────────── */

export async function generateFeatureFromBedrock(
  input: GenerateFeatureInput
): Promise<GeneratedFeatureWithPBIs> {
  const skillContent = await loadSkillContent();
  const prompt = buildFeaturePrompt(input, skillContent);

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await client.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = body.content[0]?.text ?? '';
  const parsed = JSON.parse(extractJson(text, 'Feature')) as GeneratedFeatureWithPBIs;

  const normClarificationQuestions = (arr: any): ClarificationQuestion[] | undefined => {
    if (!Array.isArray(arr) || arr.length === 0) return undefined;
    const valid = arr.filter(
      (q: any) => q && typeof q.title === 'string' && Array.isArray(q.answers) && q.answers.length > 0
    ) as ClarificationQuestion[];
    return valid.length > 0 ? valid : undefined;
  };

  const feature: GeneratedFeatureData = {
    title: parsed.feature?.title ?? '',
    description: parsed.feature?.description ?? '',
    priority: parsed.feature?.priority ?? 'Medium',
    confidence: parsed.feature?.confidence ?? 'Medium',
    tags: Array.isArray(parsed.feature?.tags) ? parsed.feature.tags : [],
    clarificationNeeded: parsed.feature?.clarificationNeeded || undefined,
    businessClarifications: normClarificationQuestions(parsed.feature?.businessClarifications),
    uiUxClarifications: normClarificationQuestions(parsed.feature?.uiUxClarifications),
  };

  const pbis: GeneratedPBIData[] = Array.isArray(parsed.pbis)
    ? parsed.pbis.map(p => ({
        title: p.title ?? '',
        description: p.description ?? '',
        acceptanceCriteria: Array.isArray(p.acceptanceCriteria) ? p.acceptanceCriteria : [],
        priority: p.priority ?? feature.priority,
        confidence: p.confidence ?? feature.confidence,
        tags: Array.isArray(p.tags) ? p.tags : [],
      }))
    : [];

  return { feature, pbis };
}

function buildFeaturePrompt(input: GenerateFeatureInput, skillContent: string): string {
  const skillSection = skillContent.trim()
    ? `## SDLC Formatting Standards (authoritative — follow these exactly)\n\n${skillContent.trim()}\n\n---\n\n`
    : '';

  const existingSample =
    input.existingFeatures.length > 0
      ? `\n\n## Existing Features under this Epic (use as style reference)\n\n${input.existingFeatures
          .map(
            f =>
              `**Title:** "${f.title}"\n**Description:** "${f.description ?? ''}"\n**Priority:** ${f.priority ?? ''} | **Confidence:** ${f.confidence ?? ''} | **Tags:** ${(f.tags ?? []).join(', ')}`
          )
          .join('\n\n')}`
      : '';

  return `You are a senior product owner using the SDLC standards defined by your organisation.

${skillSection}## Epic context

**Epic:** "${input.epicTitle}"
${input.epicDescription ? `**Epic description:**\n${input.epicDescription}` : ''}
${input.epicTags?.length ? `**Epic tags:** ${input.epicTags.join(', ')}` : ''}
${existingSample}

## User's request for the new Feature

"${input.userRequest}"

## Output requirements

${skillContent.trim() ? `Follow the SDLC Formatting Standards above exactly. In addition:` : `Rules:`}

### Feature
1. **title** — concise noun-phrase name for the feature (≤10 words).
2. **description** — structured prose in this format:
   - Opening paragraph: what the feature delivers and to whom.
   - "Business Rules:" section: 2–4 bullet points of key rules/constraints.
   - "Out of Scope:" section: 1–3 bullet points of explicit exclusions.
3. **priority** — "Critical", "High", "Medium", or "Low". Match sibling features.
4. **confidence** — "High", "Medium", or "Low".
5. **tags** — 2–5 tags derived from epic tags and feature subject matter.
6. **businessClarifications** — an array of business-focused clarification questions (optional). Each object has "title" (the question) and "answers" (array of labeled options like "a) Some option", always include "e) Other: (freeform)"). Include 2–4 questions only when there are meaningful open business decisions. Omit if confidence is High and requirements are clear.
7. **uiUxClarifications** — an array of UI/UX-focused clarification questions (optional). Same shape as businessClarifications. Include 2–3 questions only when platform, visual treatment, or interaction choices are genuinely open. Omit if not applicable.
8. **clarificationNeeded** — omit this field; use the structured arrays above instead.

### PBIs (generate 2–4 PBIs that together fully deliver the feature)
For each PBI:
1. **title** — short, action-oriented imperative phrase (≤12 words).
2. **description** — user story: "As a [specific user type], I want to [concrete action], so that [measurable benefit]."
3. **acceptanceCriteria** — 3–5 strings, each: "Given [context] When [action] Then [outcome]".
4. **priority** — match the feature priority or one level lower.
5. **confidence** — "High", "Medium", or "Low".
6. **tags** — inherited from feature + any PBI-specific tags.

Respond ONLY with valid JSON inside a fenced code block — no other text:

\`\`\`json
{
  "feature": {
    "title": "...",
    "description": "...\n\nBusiness Rules:\n- ...\n\nOut of Scope:\n- ...",
    "priority": "High",
    "confidence": "Medium",
    "tags": ["tag1", "tag2"],
    "businessClarifications": [
      {
        "title": "What is the primary business goal for this Feature?",
        "answers": ["a) Option one", "b) Option two", "c) Option three", "d) Other: (freeform)"]
      }
    ],
    "uiUxClarifications": [
      {
        "title": "Which platform(s) are in-scope for UI changes?",
        "answers": ["a) Mobile app only", "b) Desktop web only", "c) Both", "d) Other: (freeform)"]
      }
    ]
  },
  "pbis": [
    {
      "title": "...",
      "description": "As a ..., I want to ..., so that ...",
      "acceptanceCriteria": [
        "Given ... When ... Then ...",
        "Given ... When ... Then ..."
      ],
      "priority": "High",
      "confidence": "Medium",
      "tags": ["tag1", "tag2"]
    }
  ]
}
\`\`\``;
}

/* ── Clarification resolution ─────────────────────────────── */

export interface ResolveClarificationInput {
  workItemType: 'Epic' | 'Feature' | 'PBI';
  title: string;
  description?: string;
  /** Structured wizard responses (preferred) */
  clarificationResponses?: ClarificationResponses;
  /** @deprecated Use clarificationResponses instead */
  clarificationQuestion?: string;
  /** @deprecated Use clarificationResponses instead */
  userAnswer?: string;
  parentType?: string;
  parentTitle?: string;
  /** For Epic: existing Features. For Feature: existing PBIs. For PBI: sibling PBIs. */
  existingChildren?: Array<{ id: string; title: string; workItemType: string }>;
}

export interface ClarificationUpdatedFields {
  description?: string;
  clarificationNeeded?: string;
  businessClarifications?: ClarificationQuestion[];
  uiUxClarifications?: ClarificationQuestion[];
  acceptanceCriteria?: string[];
  priority?: string;
  confidence?: string;
  tags?: string[];
}

export interface ClarificationPBIData {
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  priority: string;
  confidence: string;
  tags: string[];
  clarificationNeeded?: string;
}

export interface ClarificationNewFeature {
  title: string;
  description: string;
  priority: string;
  confidence: string;
  tags: string[];
  clarificationNeeded?: string;
  /** Optional PBIs to create alongside the feature */
  pbis?: ClarificationPBIData[];
}

export interface ClarificationNewPBI extends ClarificationPBIData {
  /**
   * Epic-level only: ID of the existing Feature this PBI belongs to.
   * Omit for Feature-level (attaches to current feature) and PBI-level (attaches to sibling's parent).
   */
  targetFeatureId?: string;
}

/**
 * update         – refine the current item's fields
 * create-feature – (Epic only) create a new Feature, with optional PBIs
 * create-pbi     – create a PBI:
 *                    Feature level → under this Feature
 *                    PBI level     → sibling PBI (same parent Feature)
 *                    Epic level    → under an existing Feature (targetFeatureId)
 */
export type ClarificationAction = 'update' | 'create-feature' | 'create-pbi';

export interface ResolveClarificationResult {
  action: ClarificationAction;
  reasoning: string;
  updatedFields?: ClarificationUpdatedFields;
  newFeature?: ClarificationNewFeature;
  newPBI?: ClarificationNewPBI;
}

export async function resolveClarificationWithBedrock(
  input: ResolveClarificationInput
): Promise<ResolveClarificationResult> {
  const skillContent = await loadSkillContent();
  const prompt = buildClarificationPrompt(input, skillContent);

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  };

  const command = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  const response = await client.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = body.content[0]?.text ?? '';
  const parsed = JSON.parse(extractJson(text, 'clarification resolution')) as ResolveClarificationResult;

  const validActions: ClarificationAction[] = ['update', 'create-feature', 'create-pbi'];
  const action: ClarificationAction = validActions.includes(parsed.action as ClarificationAction)
    ? (parsed.action as ClarificationAction)
    : 'update';

  const normPBI = (p: any): ClarificationPBIData => ({
    title: p?.title ?? '',
    description: p?.description ?? '',
    acceptanceCriteria: Array.isArray(p?.acceptanceCriteria) ? p.acceptanceCriteria : undefined,
    priority: p?.priority ?? 'Medium',
    confidence: p?.confidence ?? 'Medium',
    tags: Array.isArray(p?.tags) ? p.tags : [],
    clarificationNeeded: p?.clarificationNeeded || undefined,
  });

  if (action === 'update') {
    const f = parsed.updatedFields;
    return {
      action,
      reasoning: parsed.reasoning ?? '',
      updatedFields: f
        ? {
            description: f.description,
            clarificationNeeded: f.clarificationNeeded ?? '',
            acceptanceCriteria: Array.isArray(f.acceptanceCriteria) ? f.acceptanceCriteria : undefined,
            priority: f.priority,
            confidence: f.confidence,
            tags: Array.isArray(f.tags) ? f.tags : undefined,
          }
        : undefined,
    };
  }

  if (action === 'create-feature') {
    const feat = parsed.newFeature;
    return {
      action,
      reasoning: parsed.reasoning ?? '',
      newFeature: {
        title: feat?.title ?? '',
        description: feat?.description ?? '',
        priority: feat?.priority ?? 'Medium',
        confidence: feat?.confidence ?? 'Medium',
        tags: Array.isArray(feat?.tags) ? feat!.tags : [],
        clarificationNeeded: feat?.clarificationNeeded || undefined,
        pbis: Array.isArray(feat?.pbis) ? feat!.pbis.map(normPBI) : undefined,
      },
    };
  }

  // create-pbi
  const pbi = parsed.newPBI ?? (parsed as any).newChild;
  return {
    action: 'create-pbi',
    reasoning: parsed.reasoning ?? '',
    newPBI: {
      ...normPBI(pbi),
      targetFeatureId: pbi?.targetFeatureId || undefined,
    },
  };
}

function buildClarificationPrompt(
  input: ResolveClarificationInput,
  skillContent: string
): string {
  const skillSection = skillContent.trim()
    ? `## SDLC Formatting Standards (follow these exactly)\n\n${skillContent.trim()}\n\n---\n\n`
    : '';

  const parentSection = input.parentType && input.parentTitle
    ? `**Parent ${input.parentType}:** "${input.parentTitle}"\n`
    : '';

  const childrenSection =
    input.existingChildren && input.existingChildren.length > 0
      ? `\n**Existing child items:**\n${input.existingChildren
          .map(c => `- id="${c.id}" [${c.workItemType}] "${c.title}"`)
          .join('\n')}\n`
      : '';

  /* ── Action options differ by work-item type ── */
  let actionOptions: string;
  let outputExamples: string;

  if (input.workItemType === 'Epic') {
    actionOptions = `
**"update"** — The answer refines the *Epic* itself (description, scope, tags, etc.). Set clarificationNeeded to "" to clear it.

**"create-feature"** — The answer introduces a brand-new Feature that should be added under this Epic.
  - You may optionally include 1–4 PBIs inside a \`pbis\` array if they are immediately obvious.
  - Omit \`pbis\` if it is too early to define them.

**"create-pbi"** — The answer points to a *specific existing Feature* that needs a new PBI right now.
  - Use \`targetFeatureId\` set to the id of the matching Feature from the "Existing child items" list.
  - If no existing Feature matches, prefer \`create-feature\` instead.`;

    outputExamples = `\`\`\`json
{
  "action": "create-feature",
  "reasoning": "The answer introduces a distinct self-service portal capability.",
  "newFeature": {
    "title": "Self-Service RTO Portal",
    "description": "...",
    "priority": "High",
    "confidence": "Medium",
    "tags": ["RTO", "Worker"],
    "pbis": [
      {
        "title": "Submit time-off request",
        "description": "As a Worker, I want to ..., so that ...",
        "acceptanceCriteria": ["Given ... When ... Then ..."],
        "priority": "High",
        "confidence": "Medium",
        "tags": ["RTO"]
      }
    ]
  }
}
\`\`\`

Or to add a PBI to an existing Feature:

\`\`\`json
{
  "action": "create-pbi",
  "reasoning": "The answer is a concrete PBI for the already-defined Notifications Feature.",
  "newPBI": {
    "targetFeatureId": "FEAT-002",
    "title": "Send email on approval",
    "description": "As a Worker, I want to ..., so that ...",
    "acceptanceCriteria": ["Given ... When ... Then ..."],
    "priority": "Medium",
    "confidence": "High",
    "tags": ["Notifications"]
  }
}
\`\`\``;
  } else if (input.workItemType === 'Feature') {
    actionOptions = `
**"update"** — The answer clarifies or refines the *Feature* itself (description, business rules, scope, tags, etc.). Set clarificationNeeded to "" to clear it.

**"create-pbi"** — The answer reveals a concrete new PBI that belongs under this Feature.
  - Do NOT set \`targetFeatureId\`; the PBI automatically belongs to this Feature.`;

    outputExamples = `\`\`\`json
{
  "action": "create-pbi",
  "reasoning": "The answer defines a concrete worker action that warrants its own PBI.",
  "newPBI": {
    "title": "Export RTO history to CSV",
    "description": "As a Worker, I want to ..., so that ...",
    "acceptanceCriteria": ["Given ... When ... Then ..."],
    "priority": "Medium",
    "confidence": "High",
    "tags": ["RTO", "Export"]
  }
}
\`\`\``;
  } else {
    // PBI
    actionOptions = `
**"update"** — The answer refines *this PBI* (description, acceptance criteria, priority, etc.). Set clarificationNeeded to "" to clear it.

**"create-pbi"** — The answer reveals a *separate* PBI that should be created as a sibling (under the same Feature).
  - Do NOT set \`targetFeatureId\`; the sibling PBI automatically inherits this PBI's parent Feature.`;

    outputExamples = `\`\`\`json
{
  "action": "create-pbi",
  "reasoning": "The answer introduces a distinct edge-case that deserves its own PBI.",
  "newPBI": {
    "title": "Handle expired session during submission",
    "description": "As a Worker, I want to ..., so that ...",
    "acceptanceCriteria": ["Given ... When ... Then ..."],
    "priority": "Medium",
    "confidence": "Medium",
    "tags": ["RTO", "Error Handling"]
  }
}
\`\`\``;
  }

  /* ── Format the user's clarification responses ── */
  let clarificationSection: string;
  if (input.clarificationResponses) {
    const { businessClarifications, uiUxClarifications } = input.clarificationResponses;
    const lines: string[] = [];

    const formatAnswers = (answers: ClarificationAnswer[], sectionLabel: string) => {
      if (answers.length === 0) return;
      lines.push(`### ${sectionLabel}`);
      for (const a of answers) {
        const text = a.freeformText ? `${a.selectedAnswer} — ${a.freeformText}` : a.selectedAnswer;
        lines.push(`- **${a.questionTitle}**\n  Selected: ${text}`);
      }
    };

    if (businessClarifications && businessClarifications.length > 0) {
      formatAnswers(businessClarifications, 'Business Clarifications');
    }
    if (uiUxClarifications && uiUxClarifications.length > 0) {
      formatAnswers(uiUxClarifications, 'UI/UX Clarifications');
    }
    clarificationSection = `## Clarification Wizard Responses\n\n${lines.join('\n\n')}`;
  } else {
    clarificationSection = `## Clarification Question That Was Flagged\n\n"${input.clarificationQuestion ?? ''}"\n\n## User's Answer\n\n"${input.userAnswer ?? ''}"`;
  }

  return `You are a senior product owner resolving a clarification on a backlog work item.

${skillSection}## Work Item Being Reviewed

**Type:** ${input.workItemType}
${parentSection}**Title:** "${input.title}"
${input.description ? `**Current Description:**\n${input.description}\n` : ''}${childrenSection}
${clarificationSection}

## Available Actions
${actionOptions}

Prefer **"update"** unless the answer clearly introduces a new, distinct deliverable.

## Output

Respond ONLY with valid JSON in a fenced code block.

For "update":

\`\`\`json
{
  "action": "update",
  "reasoning": "One sentence.",
  "updatedFields": {
    "description": "Revised description...",
    "clarificationNeeded": "",
    "acceptanceCriteria": ["Given ... When ... Then ..."],
    "priority": "High",
    "confidence": "Medium",
    "tags": ["tag1"]
  }
}
\`\`\`

${outputExamples}

Rules:
- Only include fields in updatedFields that actually change.
- Always include \`"clarificationNeeded": ""\` in updatedFields to clear the legacy field.
- Do NOT include businessClarifications or uiUxClarifications in updatedFields; the server clears them automatically.
- acceptanceCriteria only applies to PBI-type items.
- Match SDLC formatting standards if provided above.`;
}

/* ── PBI Prompt builder ────────────────────────────────────── */

function buildPrompt(input: GeneratePBIInput, skillContent: string): string {
  const skillSection = skillContent.trim()
    ? `## SDLC Formatting Standards (authoritative — follow these exactly)\n\n${skillContent.trim()}\n\n---\n\n`
    : '';

  const existingSample =
    input.existingPBIs.length > 0
      ? `\n\n## Existing PBIs in this feature (use as style and format reference)\n\n${input.existingPBIs
          .map(
            (p) =>
              `**Title:** "${p.title}"\n**Description:** "${p.description ?? ''}"\n**Acceptance Criteria:**\n${(p.acceptanceCriteria ?? []).map((ac) => `  - ${ac}`).join('\n')}\n**Priority:** ${p.priority ?? ''} | **Confidence:** ${p.confidence ?? ''} | **Tags:** ${(p.tags ?? []).join(', ')}`
          )
          .join('\n\n')}`
      : '';

  return `You are a senior product owner using the SDLC standards defined by your organisation.

${skillSection}## Feature context

**Feature:** "${input.featureTitle}"
${input.featureDescription ? `**Feature description:**\n${input.featureDescription}` : ''}
${input.featureTags?.length ? `**Feature tags:** ${input.featureTags.join(', ')}` : ''}
${existingSample}

## User's request for the new PBI

"${input.userRequest}"

## Output requirements

${skillContent.trim()
  ? `Follow the SDLC Formatting Standards above exactly. In addition:`
  : `Rules:`}
1. **description** — use the user story format: "As a [type of user], I want to [goal/action], so that [benefit/outcome]."
   - Identify the specific user type from context (e.g., External User, Internal User, Contact, Scheduler, Worker).
   - The "I want to" clause describes the concrete action or capability.
   - The "so that" clause states the measurable benefit.
2. **acceptanceCriteria** — an array of 3–5 strings, each strictly following:
   "Given [precondition or context] When [action or event] Then [expected outcome]"
3. **priority** — match sibling PBIs ("Critical", "High", "Medium", or "Low").
4. **confidence** — "High", "Medium", or "Low".
5. **tags** — 2–5 tags derived from feature tags and PBI subject matter.
6. **title** — short, action-oriented imperative phrase (≤12 words).

Respond ONLY with valid JSON inside a fenced code block — no other text:

\`\`\`json
{
  "title": "...",
  "description": "As a ..., I want to ..., so that ...",
  "acceptanceCriteria": [
    "Given ... When ... Then ...",
    "Given ... When ... Then ..."
  ],
  "priority": "High",
  "confidence": "Medium",
  "tags": ["tag1", "tag2"]
}
\`\`\``;
}

/* ════════════════════════════════════════════════════════════
   UI MOCK GENERATION
   ════════════════════════════════════════════════════════════ */

export type UiMockDecision = 'new-page' | 'update-page' | 'no-ui';

/** Shared page context from the feature-level mock, used when generating PBI-scoped views
 *  so the AI builds within the same page/tab structure rather than inventing a new one. */
export interface FeatureMockContext {
  /** 'new-page' or 'update-page' already decided for the feature */
  decision: UiMockDecision;
  /** The route the feature mock targets, e.g. "/shift-scheduler" */
  targetPageRoute?: string;
  /** The human-readable page title shown in the shell header */
  targetPageTitle?: string;
  /** Sub-tabs already defined on this page, e.g. ["Recurring Requests", "Calendar View"] */
  existingSubTabs?: string[];
  /** Titles of other PBI views already generated for this feature */
  siblingViewTitles?: string[];
}

/**
 * Layout-style hints passed to the model so parallel variants intentionally diverge.
 * Index 0–3 map to variant IDs A–D.
 */
export const VARIANT_HINTS: ReadonlyArray<{ label: string; hint: string }> = [
  {
    label: 'Variant A',
    hint: 'Minimal and clean: favour whitespace, card-based layout, concise labels, and a simple toolbar with only the most essential actions.',
  },
  {
    label: 'Variant B',
    hint: 'Data-dense, table-first: maximise information density with a full-featured DataTable, sortable columns, inline status chips, and a rich toolbar (Columns / Filters / Density / Export).',
  },
  {
    label: 'Variant C',
    hint: 'Card-grid visual: display records as cards in a responsive grid, emphasise status colour-coding, include a search bar and a summary stat row at the top.',
  },
  {
    label: 'Variant D',
    hint: 'Step-by-step wizard or detail panel: use a wizard stepper, split detail-panel layout (main + sidebar), or a multi-step form — ideal when the primary action requires guided input.',
  },
] as const;

export interface GenerateUiMockInput {
  featureTitle: string;
  featureDescription?: string;
  featureTags?: string[];
  acceptanceCriteria?: string[];
  epicTitle?: string;
  /** ID of the PBI being rendered (required when featurePlan is provided so the
   *  prompt can look up this PBI's planned contribution). */
  pbiId?: string;
  catalog: DesignSystemCatalog;
  /** When generating a PBI-scoped view, pass the feature-level mock context so the AI
   *  stays within the same page/tab structure rather than making a fresh routing decision. */
  featureContext?: FeatureMockContext;
  /** Structured UI surface plan (from feature.uiSurfacePlan or synthesised from
   *  feature.uiMock). When present, PBI generation is locked to the planned surface. */
  featurePlan?: UiSurfacePlan;
  /** Free-form context provided by the BA/UX designer at generation time —
   *  e.g. tone, user persona, specific constraints, or layout preferences.
   *  Applied to every mock in a "Generate All" batch for consistency. */
  additionalContext?: string;
  /** Full HTML of the feature-overview mock (when generating a PBI-scoped view as part
   *  of a "Generate All" batch). The inner content is extracted and shown to the AI so
   *  it can mirror the same layout patterns, CSS classes, and component choices. */
  featureOverviewHtml?: string;
  /** Layout-style hint injected when generating one of N parallel variants.
   *  Causes the model to intentionally diverge from the other variants. */
  variantHint?: string;
}

/* ── UI Plan types ─────────────────────────────────────────── */

export interface PbiSummary {
  pbiId: string;
  pbiTitle: string;
  description?: string;
  acceptanceCriteria?: string[];
}

export interface GenerateUiPlanInput {
  scope: 'epic' | 'feature';
  /** Title of the epic (when scope='epic') or feature (when scope='feature'). */
  title: string;
  description?: string;
  epicTitle?: string;
  /** All child PBIs under this epic or feature. */
  childPbis: PbiSummary[];
  /** All sibling features under the same epic (for epic-scope plans). */
  siblingFeatures?: Array<{ title: string; description?: string }>;
  catalog: DesignSystemCatalog;
  additionalContext?: string;
  /** When refining a feature plan from an epic plan, pass the epic plan here. */
  epicPlan?: UiSurfacePlan;
  /**
   * Plans from OTHER features in the same epic that already target the same
   * page route as this feature intends to use. When present, the prompt locks
   * the shared surface structure (route, title, sub-tabs, layout, primary
   * components) and asks the model to only describe this feature's additive
   * delta — preventing each feature from independently re-inventing the page.
   */
  existingSurfacePlans?: Array<{
    featureTitle: string;
    plan: UiSurfacePlan;
  }>;
}

export interface RegenerateUiMockInput extends GenerateUiMockInput {
  priorHtml: string;
  priorDecision: UiMockDecision;
  priorTargetRoute?: string;
  /** Page title currently shown in the shell — passed so the model knows what
   *  the user means by phrases like "rename the page" without inventing a new one. */
  priorPageTitle?: string;
  /** Sub-tabs currently rendered for this page (in display order). The shell
   *  renders tabs from JSON output, NOT from the inner HTML, so the model has
   *  no way to know the current tab list unless we send it explicitly. */
  priorSubTabs?: string[];
  /** Currently active sub-tab label, if any. */
  priorActiveSubTab?: string;
  feedback: string;
}

export interface UiMockResult {
  decision: UiMockDecision;
  rationale: string;
  targetPageRoute?: string;
  targetPageTitle?: string;
  targetPageSubTabs?: string[];
  targetSubTabActive?: string;
  mockHtml?: string;
}

/* ── MaxView shell template ───────────────────────────────── */

/**
 * Default MaxView sidebar nav items, sourced from the actual Figma design
 * (file: ZsL1t2zBbuBCQDwgVHCvEO, "Document Manager - Default" frame).
 * The catalog may add more from the live repo.
 */
const DEFAULT_NAV_ITEMS = [
  { label: 'Home',                route: '/home',              icon: 'grid_view' },
  { label: 'Companies',           route: '/Companies',         icon: 'folder_open' },
  { label: 'Worksites',           route: '/Worksites',         icon: 'assignment' },
  { label: 'Users',               route: '/Users',             icon: 'assignment' },
  { label: 'Shift Scheduler',     route: '/PerDiemShift',      icon: 'calendar_month' },
  { label: 'RTO Management',      route: '/AbsenceManagement', icon: 'calendar_month' },
  { label: 'Coder',               route: '/Coder',             icon: 'assignment' },
  { label: 'Credentials',         route: '/Credentials',       icon: 'folder_open' },
  { label: 'Document Management', route: '/DocumentManagement', icon: 'folder_open' },
  { label: 'Timecards',           route: '/Timecard',          icon: 'timer' },
  { label: 'Admin Portal',        route: '/AdminPortal/Landing', icon: 'grid_view' },
  { label: 'Power BI',            route: '/PowerBI',           icon: 'dashboard' },
];

/**
 * Inline SVG icons for nav items keyed by Material Icons name.
 * Self-contained — no external fonts or network requests needed in the iframe.
 */
const NAV_ICON_SVG: Record<string, string> = {
  grid_view: `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h8v8H3zm0 10h8v8H3zm10-10h8v8h-8zm0 10h8v8h-8z"/></svg>`,
  folder_open: `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm0 12H4V8h16v10z"/></svg>`,
  assignment: `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`,
  calendar_month: `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M20 3h-1V1h-2v2H7V1H5v2H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 18H4V8h16v13zM9 10H7v2h2zm4 0h-2v2h2zm4 0h-2v2h2zM9 14H7v2h2zm4 0h-2v2h2zm4 0h-2v2h2z"/></svg>`,
  timer: `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61l1.42-1.42a10.07 10.07 0 0 0-1.41-1.41L17.62 6A8 8 0 1 0 19.03 7.39zM12 20a6 6 0 1 1 0-12 6 6 0 0 1 0 12z"/></svg>`,
  dashboard: `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>`,
  default: `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>`,
  '+': `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-6V5h-2v6H5v2h6v6h2v-6h6z"/></svg>`,
};

/**
 * Builds the full MaxView HTML shell that wraps the feature content.
 *
 * Based on actual Figma design (EDtAXPJZtgxFFoHSZt8deF / ZsL1t2zBbuBCQDwgVHCvEO):
 * - Left white sidebar (280px) with "maxview" logo, search, icon+text nav items
 * - Right content area on #f5f5f5 background
 * - Content page header: large title left, "Hello, Name!" + avatar right
 * - Sub-tabs below the title (underline style, blue active)
 * - Table/card content below
 *
 * @param navItems      Nav items to show in sidebar
 * @param activeRoute   Route to mark active (null = first nav item)
 * @param newPageLabel  If decision is "new-page", label for the new nav entry
 * @param subTabs       Sub-tab labels for the content header (empty = no tabs)
 * @param activeSubTab  Active sub-tab label
 * @param pageTitle     Page title shown in content header
 * @param contentSlot   Inner content HTML (placed below sub-tabs)
 */
function buildMaxViewShell({
  navItems,
  activeRoute,
  newPageLabel,
  subTabs,
  activeSubTab,
  pageTitle,
  contentSlot,
}: {
  navItems: Array<{ label: string; route: string; icon: string }>;
  activeRoute: string | null;
  newPageLabel: string | null;
  subTabs: string[];
  activeSubTab: string | null;
  pageTitle: string;
  contentSlot: string;
}): string {
  const allNavItems = newPageLabel
    ? [...navItems, { label: newPageLabel, route: '/new', icon: '+' }]
    : navItems;

  const navHtml = allNavItems
    .map(({ label, route, icon }) => {
      const isActive = activeRoute ? route === activeRoute : false;
      const isNewPage = route === '/new';
      const iconHtml = NAV_ICON_SVG[icon ?? ''] ?? NAV_ICON_SVG['default'];
      return `<li class="nav-item${isActive ? ' active' : ''}${isNewPage ? ' nav-item--new' : ''}">
          ${iconHtml}
          <span class="nav-label">${label}</span>
        </li>`;
    })
    .join('\n        ');

  const subTabsHtml = subTabs.length > 0
    ? `<div class="sub-nav">
          ${subTabs.map(t =>
              `<button class="sub-tab${t === activeSubTab ? ' active' : ''}">${t}</button>`
            ).join('\n          ')}
        </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    font-size: 14px;
    color: #1a1a2e;
    background: #f5f5f7;
  }

  /* ── Layout ── */
  .mwx-app { display: flex; height: 100vh; overflow: hidden; }

  /* ── Left sidebar ── */
  .mwx-nav {
    width: 200px;
    flex-shrink: 0;
    background: #ffffff;
    border-right: 1px solid #e5e7eb;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }
  .mwx-logo {
    padding: 20px 16px 16px;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.5px;
    background: linear-gradient(90deg, #14b8c8 0%, #2563eb 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    color: transparent;
    user-select: none;
  }
  .nav-search {
    margin: 0 12px 12px;
    padding: 7px 10px 7px 30px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    font-size: 13px;
    color: #9ca3af;
    background: #f9fafb url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E") no-repeat 10px center;
    width: calc(100% - 24px);
  }
  .nav-list { list-style: none; padding: 0 8px; flex: 1; }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-radius: 6px;
    cursor: default;
    color: #6b7280;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 2px;
  }
  .nav-item.active {
    background: #eff6ff;
    color: #2563eb;
    font-weight: 600;
  }
  .nav-item--new {
    color: #2563eb;
    border: 1px dashed #93c5fd;
    background: #f0f9ff;
  }
  .nav-icon { width: 18px; height: 18px; flex-shrink: 0; display: block; }
  .nav-icon-dot { width: 6px; height: 6px; background: currentColor; border-radius: 50%; flex-shrink: 0; opacity: 0.5; }

  /* ── Workspace ── */
  .mwx-workspace {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: #f5f5f7;
  }

  /* Workspace top bar */
  .mwx-topbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 12px 24px;
    background: #ffffff;
    border-bottom: 1px solid #e5e7eb;
    gap: 12px;
    flex-shrink: 0;
  }
  .mwx-greeting {
    font-size: 13px;
    color: #374151;
    font-weight: 500;
  }
  .mwx-avatar {
    width: 34px; height: 34px;
    border-radius: 50%;
    background: #2563eb;
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Page header */
  .mwx-page-header {
    padding: 20px 28px 0;
    background: #ffffff;
    border-bottom: 1px solid #e5e7eb;
    flex-shrink: 0;
  }
  .mwx-page-title {
    font-size: 22px;
    font-weight: 700;
    color: #111827;
    margin-bottom: 14px;
  }

  /* Sub-nav tabs */
  .sub-nav {
    display: flex;
    gap: 4px;
  }
  .sub-tab {
    padding: 8px 16px;
    border: none;
    background: transparent;
    font-size: 13px;
    font-weight: 500;
    color: #6b7280;
    cursor: default;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .sub-tab.active {
    color: #2563eb;
    border-bottom-color: #2563eb;
    font-weight: 600;
  }

  /* Content body */
  .mwx-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px 28px;
  }

  /* ── Toolbar row (Columns / Filters / Density / Export + Search) ── */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .toolbar-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 6px 12px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #ffffff;
    font-size: 12px;
    font-weight: 500;
    color: #374151;
    cursor: default;
  }
  .toolbar-search {
    margin-left: auto;
    padding: 7px 12px 7px 32px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    background: #ffffff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='13' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.35-4.35'/%3E%3C/svg%3E") no-repeat 10px center;
    font-size: 13px;
    color: #6b7280;
    min-width: 200px;
  }

  /* ── Data table ── */
  .mwx-table-wrap {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead { background: #f9fafb; }
  th {
    text-align: left;
    padding: 10px 14px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
    border-bottom: 1px solid #e5e7eb;
  }
  td { padding: 11px 14px; border-bottom: 1px solid #f3f4f6; color: #374151; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .table-pagination {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 8px 14px;
    font-size: 12px;
    color: #6b7280;
    gap: 12px;
    border-top: 1px solid #f3f4f6;
  }
  .pagination-arrow { color: #9ca3af; cursor: default; font-size: 16px; }

  /* ── Status chips ── */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 9px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .chip::before { content: '●'; font-size: 8px; }
  .chip-active     { background: #dcfce7; color: #15803d; }
  .chip-pending    { background: #dbeafe; color: #1d4ed8; }
  .chip-review     { background: #fff7ed; color: #c2410c; }
  .chip-completed  { background: #dcfce7; color: #15803d; }
  .chip-draft      { background: #f3f4f6; color: #6b7280; }
  .chip-inactive   { background: #f3f4f6; color: #9ca3af; }

  /* ── Cards / panels ── */
  .card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 18px 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
  }
  .card + .card { margin-top: 14px; }
  .card-title { font-size: 15px; font-weight: 600; color: #111827; margin-bottom: 12px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .stat-value { font-size: 30px; font-weight: 700; color: #111827; line-height: 1; }
  .stat-label { font-size: 12px; color: #6b7280; margin-top: 4px; }

  /* ── Buttons ── */
  .btn-primary   { padding: 8px 18px; background: #2563eb; color: #fff; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: default; }
  .btn-secondary { padding: 8px 18px; background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: default; }
  .btn-ghost     { padding: 6px 12px; background: none; color: #6b7280; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 12px; cursor: default; }

  /* ── Form controls ── */
  input[type=text], select, textarea {
    padding: 8px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 13px;
    color: #374151;
    background: #fff;
  }
  label { font-size: 12px; font-weight: 600; color: #374151; display: block; margin-bottom: 4px; }
  .form-row { display: flex; gap: 14px; margin-bottom: 14px; }
  .form-field { flex: 1; }

  /* ── Annotation (highlight new/changed area) ── */
  .annotation {
    border: 2px dashed #2563eb;
    border-radius: 8px;
    padding: 14px 16px;
    background: rgba(37,99,235,0.04);
    margin-bottom: 14px;
  }
  .annotation-label {
    font-size: 10px;
    font-weight: 800;
    color: #2563eb;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .annotation-label::before { content: '★'; }
  .new-section {
    border-left: 3px solid #2563eb;
    padding-left: 14px;
    background: rgba(37,99,235,0.03);
    border-radius: 0 6px 6px 0;
    margin-bottom: 14px;
  }

  /* ── Detail panel layout (sidebar + content within workspace) ── */
  .detail-layout { display: flex; gap: 16px; align-items: flex-start; }
  .detail-main { flex: 1; }
  .detail-side { width: 280px; flex-shrink: 0; }

  /* ── Misc helpers ── */
  .flex { display: flex; }
  .items-center { align-items: center; }
  .justify-between { justify-content: space-between; }
  .gap-8 { gap: 8px; }
  .gap-12 { gap: 12px; }
  .mb-14 { margin-bottom: 14px; }
  .text-sm { font-size: 12px; }
  .text-muted { color: #9ca3af; }
  .font-600 { font-weight: 600; }
  .text-blue { color: #2563eb; }
</style>
</head>
<body>
<div class="mwx-app">

  <!-- Left sidebar nav -->
  <nav class="mwx-nav">
    <div class="mwx-logo">maxview</div>
    <input class="nav-search" type="text" value="" placeholder="Search" readonly />
    <ul class="nav-list">
      ${navHtml}
    </ul>
  </nav>

  <!-- Right workspace -->
  <div class="mwx-workspace">
    <!-- Top bar: greeting + avatar -->
    <div class="mwx-topbar">
      <span class="mwx-greeting">Hello, Reese!</span>
      <div class="mwx-avatar">RT</div>
    </div>

    <!-- Page header: title + sub-tabs -->
    <div class="mwx-page-header">
      <div class="mwx-page-title">${pageTitle}</div>
      ${subTabsHtml}
    </div>

    <!-- Content -->
    <div class="mwx-content">
      <!-- CONTENT_START -->${contentSlot}<!-- CONTENT_END -->
    </div>
  </div>

</div>
</body>
</html>`;
}

/* ── Catalog section (for prompt context) ─────────────────── */

function buildCatalogSection(catalog: DesignSystemCatalog): string {
  const parts: string[] = [];

  // UI knowledge base goes first — it describes each existing screen in detail,
  // giving the AI the richest possible context for the new-page vs update-page decision.
  if (catalog.uiKnowledgeBase?.trim()) {
    parts.push(`### Existing screens — detailed descriptions\n\n${catalog.uiKnowledgeBase.trim()}`);
  }

  const routeLayoutHints = catalog.routeLayoutHints ?? {};
  const routeList = catalog.routes.length > 0
    ? catalog.routes.map(r => {
        const layout = routeLayoutHints[r.path];
        return `- \`${r.path}\` — ${r.title}${layout ? ` *(layout: ${layout})*` : ''}`;
      }).join('\n')
    : DEFAULT_NAV_ITEMS.map(n => `- \`${n.route}\` — ${n.label}`).join('\n');

  parts.push(`### Existing application pages (MaxView sidebar nav)\n\n${routeList}`);

  if (catalog.componentNames.length > 0) {
    const names = catalog.componentNames.slice(0, 40);
    const descriptions = catalog.componentDescriptions ?? {};
    const componentLines = names.map(n => {
      const desc = descriptions[n];
      return desc ? `- \`${n}\` — ${desc}` : `- \`${n}\``;
    });
    parts.push('### Existing components in the codebase\n\n' + componentLines.join('\n'));
  }

  // Canonical MaxView color palette — the AI must use these exact values rather
  // than inventing hex/rgba colors. Bundled as a local asset (designTokensService).
  const colorTokens = getMaxviewColorTokens();
  if (colorTokens) {
    parts.push(
      '### MaxView Design Tokens — colors (REQUIRED)\n\n' +
      'Use ONLY the colors defined below. Pick by semantic role (e.g. `error.main` for errors, ' +
      '`primary.main` for primary actions). NEVER invent hex or rgba values not listed here.\n\n' +
      colorTokens
    );
  }

  return `## MaxView Application Context\n\n${parts.join('\n\n')}\n\n---\n\n`;
}

/** Loosely normalise a route for matching (lowercase, drop query/anchor + trailing slash). */
function normaliseRouteForMatch(route: string): string {
  let r = (route ?? '').trim().split(/[?#]/)[0].toLowerCase();
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  if (r && !r.startsWith('/')) r = `/${r}`;
  return r;
}

/** Match a (possibly comma-separated) inventory route cell against a single target route. */
function inventoryRouteMatches(inventoryRoute: string, target: string): boolean {
  const nt = normaliseRouteForMatch(target);
  return inventoryRoute.split(',').some(sub => normaliseRouteForMatch(sub) === nt);
}

/**
 * Compact screens-context block derived from the clientapp-screens.md inventory.
 * One line per screen: `route` — purpose [users: …] [states: …]. The user-types and
 * states annotations are only appended when present. Returns '' when the inventory is empty.
 */
function buildScreensContextSection(inventory: ScreenInventoryRoute[]): string {
  const lines = inventory
    .filter(s => s.route)
    .map(s => {
      let line = `- \`${s.route}\``;
      if (s.purpose) line += ` — ${s.purpose}`;
      if (s.userTypes?.length) line += ` [users: ${s.userTypes.join(', ')}]`;
      if (s.states) line += ` [states: ${s.states}]`;
      return line;
    });

  if (lines.length === 0) return '';

  return `### Existing MaxView screens — inventory (route — purpose — user types — states)\n\n` +
    `Use this to understand which personas each screen serves and the UI states it supports.\n\n` +
    lines.join('\n') + '\n\n---\n\n';
}

/* ── Prompt builders ──────────────────────────────────────── */

function buildUiMockPrompt(input: GenerateUiMockInput, skillContent: string): string {
  const skillSection = skillContent.trim()
    ? `## SDLC Formatting Standards\n\n${skillContent.trim()}\n\n---\n\n`
    : '';
  const catalogSection = buildCatalogSection(input.catalog);

  const acSection = input.acceptanceCriteria?.length
    ? `\n**Acceptance Criteria:**\n${input.acceptanceCriteria.map(a => `- ${a}`).join('\n')}`
    : '';
  const tagsSection = input.featureTags?.length
    ? `\n**Tags:** ${input.featureTags.join(', ')}`
    : '';
  const additionalContextSection = input.additionalContext?.trim()
    ? `\n## Additional context from BA/UX\n\n${input.additionalContext.trim()}\n`
    : '';

  const featureOverviewSection = input.featureOverviewHtml?.trim()
    ? (() => {
        const inner = extractInnerContent(input.featureOverviewHtml);
        return `\n## Feature overview mock (visual style reference)\n\nThe feature-level overview mock was already generated. **Your HTML must reuse the same CSS classes, layout patterns, toolbar structure, table conventions, and component choices** so all views feel like one consistent screen.\n\nInner content of the feature overview mock:\n\`\`\`html\n${inner}\n\`\`\`\n`;
      })()
    : '';

  const variantHintSection = input.variantHint?.trim()
    ? `\n## Layout variant instruction\n\n**Apply the following layout style** to this mock. This is one of several parallel alternatives being generated — your output should intentionally reflect this style so users can compare different approaches:\n\n> ${input.variantHint.trim()}\n`
    : '';

  /* Get the Figma reference for nav items and visual context */
  const ref = getFigmaReference();
  const navItemsForRouteList = ref.navItems.length > 0 ? ref.navItems : DEFAULT_NAV_ITEMS;
  const validRoutes = input.catalog.routes.length > 0
    ? input.catalog.routes.map(r => `"${r.path}"`)
    : navItemsForRouteList.map(n => `"${n.route}"`);

  const screenshotSection = ref.tablePageBase64
    ? `## Visual reference (attached image)

The image attached to this message is a screenshot from the MaxView Figma design file showing a real page.
**Match this visual style exactly** when generating the content HTML:
- Same font family, size, and weight hierarchy
- Same background colors (#ffffff sidebar, #f5f5f7 workspace, white content cards)
- Same table style (light #f9fafb thead, thin #f3f4f6 row borders, 11px uppercase headers)
- Same status chip styles (green = Active/Completed, blue = Pending Signatures, orange = Needs Review)
- Same toolbar pattern (Columns / Filters / Density / Export buttons + Search on right)
- Same sidebar nav (white bg, "maxview" gradient logo, icon + label items)
- Same page header (large title left, "Hello, Reese!" + blue avatar right)
- Same underline sub-tabs below the page title

`
    : '';

  /* ── Plan-locked surface block — takes priority over featureContext when present ── */
  const plan = input.featurePlan;
  const pbiContribution = plan && input.pbiId
    ? plan.pbiContributions.find(c => c.pbiId === input.pbiId)
    : undefined;

  const planLockedSection = plan
    ? `## Plan-locked UI surface — DO NOT deviate

A UI Surface Plan has been established for this feature. **You MUST NOT change any of the locked values below.** Your only job is to render the specific delta described for this PBI.

\`\`\`json
${JSON.stringify({
  decision: plan.decision,
  targetPageRoute: plan.targetPageRoute ?? null,
  targetPageTitle: plan.targetPageTitle ?? null,
  subTabs: plan.subTabs,
  activeSubTab: plan.activeSubTab ?? null,
  layoutPattern: plan.layoutPattern ?? null,
  primaryComponents: plan.primaryComponents,
}, null, 2)}
\`\`\`

${pbiContribution ? `### This PBI's planned contribution

- **Contribution type:** \`${pbiContribution.contributionType}\`
- **Target area:** ${pbiContribution.targetArea}
- **Delta summary:** ${pbiContribution.summary}

Render ONLY this contribution as the inner content HTML. Wrap it in \`.annotation\` + \`.annotation-label "NEW"\` so it is visually distinguished. Keep any surrounding scaffolding (toolbar, table structure, other tabs) visually identical to the rest of the page.` : ''}

**LOCKED values (DO NOT change in your output):**
- \`decision\` → \`${plan.decision}\`
- \`targetPageRoute\` → \`${plan.targetPageRoute ?? 'null'}\`
- \`targetPageTitle\` → \`${plan.targetPageTitle ?? 'null'}\`
- \`targetPageSubTabs\` → \`${JSON.stringify(plan.subTabs)}\` (add a new tab only if the contribution type is "new-tab")

---

`
    : '';

  /* ── Fallback: legacy featureContext block (used when no plan is present) ── */
  const ctx = !plan ? input.featureContext : undefined;
  const featureContextSection = ctx
    ? `## Established page context for this feature

This view is one of several being generated for the same feature. The feature-level mock has already established the following — **you must stay within this structure**:

- **Decision:** ${ctx.decision} (DO NOT change this — use the same routing decision)
${ctx.targetPageRoute ? `- **Page route:** \`${ctx.targetPageRoute}\`` : ''}
${ctx.targetPageTitle ? `- **Page title:** "${ctx.targetPageTitle}"` : ''}
${ctx.existingSubTabs?.length ? `- **Sub-tabs already on this page:** ${ctx.existingSubTabs.map(t => `"${t}"`).join(', ')} — keep these, and add a new tab for this PBI if appropriate` : ''}
${ctx.siblingViewTitles?.length ? `- **Other PBI views already generated:** ${ctx.siblingViewTitles.map(t => `"${t}"`).join(', ')}` : ''}

Your HTML must fit within this established page. Use the same \`targetPageRoute\`, \`targetPageTitle\`, and include all existing sub-tabs plus any new one needed for this PBI.

---

`
    : '';

  return `You are a senior UX designer and product analyst for MaxView — a workforce management web application used by healthcare staffing agencies.

${screenshotSection}The app has a LEFT SIDEBAR navigation: ${navItemsForRouteList.map(n => n.label).join(', ')}.
Each page has a page title header, optional sub-tabs (underline style), then a content body area.

${skillSection}${catalogSection}${planLockedSection}${featureContextSection}## Feature to analyse

**Feature:** "${input.featureTitle}"
${input.epicTitle ? `**Epic:** "${input.epicTitle}"\n` : ''}${input.featureDescription ? `**Description:**\n${input.featureDescription}\n` : ''}${acSection}${tagsSection}${additionalContextSection}${variantHintSection}${featureOverviewSection}

## Your task

### Step 1 — Make the UI decision

${plan
  ? `The routing decision is LOCKED by the UI Surface Plan above. Use **${plan.decision}**${plan.targetPageRoute ? ` targeting \`${plan.targetPageRoute}\`` : ''}. Do NOT override it.`
  : ctx
    ? `The routing decision is already established (see "Established page context" above). Use **${ctx.decision}**${ctx.targetPageRoute ? ` targeting \`${ctx.targetPageRoute}\`` : ''}. Do not override it.`
    : `Use the "Existing screens — detailed descriptions" section above to understand what each current page already covers before deciding.

Decide whether this feature requires:
1. **new-page** — warrants a brand new page/section in the left nav (no existing screen is a natural home for it).
2. **update-page** — adds to or modifies an existing page. Choose the best matching route from the catalog above, informed by the screen descriptions.
3. **no-ui** — entirely backend, a data migration, a scheduled job, a configuration change, or otherwise has no user-facing UI.`
}

### Step 2 — Produce the content HTML

For "new-page" or "update-page", produce **only the inner body content HTML** that goes inside \`.mwx-content\`.

The system will inject the full MaxView shell automatically (sidebar nav, topbar, page header). Do NOT re-render the shell yourself.
**The shell already renders the page title above the content. Do NOT start the content with an \`<h1>\`, \`<h2>\`, or any element that repeats the page name — it will appear twice.**

The injected shell provides these CSS classes — use them:

**Tables & data:**
\`.mwx-table-wrap > table\`, \`thead/th\`, \`td\`, \`.table-pagination\`

**Toolbar:**
\`.toolbar\`, \`.toolbar-btn\`, \`.toolbar-search\`

**Status chips (use real MaxView statuses):**
\`.chip .chip-active\` (green), \`.chip .chip-pending\` (blue), \`.chip .chip-review\` (orange), \`.chip .chip-completed\` (green), \`.chip .chip-draft\` (gray)

**Cards & layout:**
\`.card\`, \`.card-title\`, \`.grid-2\`, \`.grid-3\`, \`.stat-value\`, \`.stat-label\`
\`.detail-layout\`, \`.detail-main\`, \`.detail-side\`

**Forms:**
\`input[type=text]\`, \`select\`, \`textarea\`, \`label\`, \`.form-row\`, \`.form-field\`

**Buttons:**
\`.btn-primary\` (blue filled), \`.btn-secondary\` (white outlined), \`.btn-ghost\`

**Annotations (highlight new/changed):**
\`.annotation\` + \`.annotation-label\` (blue dashed border)
\`.new-section\` (blue left border)

**Helpers:** \`.flex\`, \`.items-center\`, \`.justify-between\`, \`.gap-8\`, \`.gap-12\`, \`.mb-14\`, \`.text-sm\`, \`.text-muted\`, \`.font-600\`, \`.text-blue\`

Rules:
- Start content with a \`.toolbar\` row (columns/filters/export buttons + search input) if it is a table-based page.
- Wrap the data table in \`.mwx-table-wrap\`.
- Use realistic placeholder data (names, dates, numbers matching the domain).
- Wrap the new/changed area in \`.annotation\` with an \`.annotation-label\` saying "NEW" or "UPDATED".
- Do NOT use \`<script>\`, external URLs, \`on*\` event attributes, or \`<style>\` tags.
- Keep content HTML to 60–120 lines.

Also return:
- \`targetPageTitle\`: the human-readable name that appears in the page header (e.g. "Candidate Management")
- \`targetPageSubTabs\`: array of sub-tab labels shown below the title (e.g. ["All Documents", "Send Documents", "History"]) — empty array if no tabs
- \`targetSubTabActive\`: which sub-tab is active (e.g. "All Documents") — null if no tabs

Valid targetPageRoute values: ${validRoutes.join(', ')}

## Output (JSON only)

\`\`\`json
{
  "decision": "new-page" | "update-page" | "no-ui",
  "rationale": "One or two sentences explaining the decision.",
  "targetPageRoute": "/existing-route" | null,
  "targetPageTitle": "Human-readable page title" | null,
  "targetPageSubTabs": ["Tab One", "Tab Two"] | [],
  "targetSubTabActive": "Tab One" | null,
  "mockHtml": "<div>...content only, no outer shell...</div>" | null
}
\`\`\`

Rules:
- targetPageRoute is null for "no-ui" and for "new-page".
- targetPageTitle is required for all non-null mocks.
- mockHtml is null for "no-ui".
- Respond ONLY with the JSON fenced block — no other text.`;
}

/**
 * Strips the full MaxView shell from a stored mockHtml, returning only the
 * inner content that sits inside .mwx-content. Falls back to the full string
 * when markers are absent (e.g. older saved mocks).
 */
function extractInnerContent(fullHtml: string): string {
  const m = fullHtml.match(/<!-- CONTENT_START -->([\s\S]*?)<!-- CONTENT_END -->/);
  return m ? m[1].trim() : fullHtml;
}

function buildRegenerateUiMockPrompt(input: RegenerateUiMockInput, skillContent: string): string {
  const skillSection = skillContent.trim()
    ? `## SDLC Formatting Standards\n\n${skillContent.trim()}\n\n---\n\n`
    : '';

  const acSection = input.acceptanceCriteria?.length
    ? `\n**Acceptance Criteria:**\n${input.acceptanceCriteria.map(a => `- ${a}`).join('\n')}`
    : '';

  const ref = getFigmaReference();
  const screenshotRef = ref.tablePageBase64
    ? `An image is attached showing the original MaxView design system. Use it ONLY as a CSS-class and color reference if you need to add new elements — DO NOT treat it as an instruction to redesign the current mock. The current mock below is your source of truth.\n\n`
    : '';

  const innerContent = extractInnerContent(input.priorHtml);

  /* The shell (sidebar nav, page header, sub-tabs) is NOT in the inner HTML —
     it is rendered separately from the JSON's targetPage* fields. The model
     therefore has zero visibility into the current tab list / page title
     unless we surface them explicitly here. */
  const subTabsLine = input.priorSubTabs && input.priorSubTabs.length > 0
    ? `Sub-tabs (current order — preserve EXACTLY unless feedback removes/renames specific ones): ${input.priorSubTabs.map(t => `"${t}"`).join(', ')}`
    : `Sub-tabs: (none currently)`;
  const activeTabLine = input.priorActiveSubTab
    ? `Active sub-tab: "${input.priorActiveSubTab}"`
    : '';
  const titleLine = input.priorPageTitle
    ? `Page title (preserve unless feedback renames it): "${input.priorPageTitle}"`
    : '';

  return `You are a senior UX designer modifying an EXISTING UI mock for MaxView — a workforce management web application.

${screenshotRef}${skillSection}# YOUR PRIMARY DIRECTIVE

You are NOT generating a new mock. You are EDITING the existing mock below to apply the BA/PO's feedback.

**Treat every field of the "Current mock state" below as the baseline. Your output should be that exact state, with ONLY the smallest possible edits needed to satisfy the feedback.**

- If the feedback says "I like the design, just add a sort button" → return the SAME HTML with a sort button added. Same colors, same spacing, same structure, same components, same copy.
- If the feedback says "remove the search bar" → return the SAME HTML with only the search bar removed. Everything else identical.
- If the feedback says "remove the X tab" → return \`targetPageSubTabs\` as the EXACT current list with ONLY "X" removed. Preserve every other tab in its current order.
- If the feedback says "rename the page to Foo" → set \`targetPageTitle\` to "Foo" and return the SAME HTML body unchanged (the title lives in the shell, not the body).
- Do NOT redesign the layout, change the toolbar, swap tables for cards, restyle elements, rename existing labels, reword copy, reorder or rename sub-tabs, or alter structural patterns unless the feedback explicitly requests it.
- Affirmations like "I like it", "looks good", "keep the design" mean: change NOTHING except what the feedback explicitly calls out.

If you find yourself rewriting more than ~20% of the HTML, or replacing the sub-tab list with a different set, STOP — you are over-editing. Roll back and make only the targeted change.

---

## Feature context (for reference only — NOT a regeneration brief)

**Feature:** "${input.featureTitle}"
${input.featureDescription ? `**Description:**\n${input.featureDescription}\n` : ''}${acSection}

## Current mock state — THIS IS YOUR STARTING POINT

Decision: ${input.priorDecision}${input.priorTargetRoute ? ` | Route: ${input.priorTargetRoute}` : ''}
${titleLine}
${subTabsLine}
${activeTabLine}

### Current inner HTML

\`\`\`html
${innerContent}
\`\`\`

## BA/PO Feedback — apply THIS and ONLY this

"${input.feedback}"

---

## Output rules

1. **Start from the state above.** Output the same HTML verbatim, the same \`targetPageTitle\`, the same \`targetPageRoute\`, and the same \`targetPageSubTabs\` list — applying only the targeted edits the feedback asks for.
2. **Sub-tabs especially**: \`targetPageSubTabs\` MUST mirror the current sub-tabs list shown above, with edits applied ONLY if the feedback explicitly mentions tabs. Removing one tab means removing exactly one from the list, not regenerating the whole list. If the feedback does not mention tabs, your \`targetPageSubTabs\` MUST be byte-identical to the current list.
3. **Active sub-tab**: keep \`targetSubTabActive\` set to the current active tab unless the feedback removes that tab (in which case pick a sibling) or explicitly switches the active one.
4. Preserve every CSS class, attribute, copy string, status chip, table column, and layout block that the feedback does not explicitly modify.
5. Page title renames go in \`targetPageTitle\` (not the HTML body). If the feedback specifies a page name, you MUST set \`targetPageTitle\` to that exact name.
6. You may revise \`decision\` or \`targetPageRoute\` only if the feedback explicitly implies it.
7. Do NOT add \`<script>\`, external URLs, \`on*\` event handlers, or \`<style>\` blocks.
8. Do NOT start the content with \`<h1>\` / \`<h2>\` — the shell renders the page title above \`.mwx-content\`.

Available CSS classes (already defined in the shell — reuse only):
\`.toolbar\`, \`.toolbar-btn\`, \`.toolbar-search\`, \`.mwx-table-wrap\`, \`table/thead/th/td\`, \`.table-pagination\`,
\`.chip .chip-active\`, \`.chip-pending\`, \`.chip-review\`, \`.chip-completed\`, \`.chip-draft\`,
\`.card\`, \`.card-title\`, \`.grid-2\`, \`.grid-3\`, \`.stat-value\`, \`.stat-label\`,
\`.btn-primary\`, \`.btn-secondary\`, \`.btn-ghost\`,
\`input[type=text]\`, \`select\`, \`textarea\`, \`.form-row\`, \`.form-field\`,
\`.annotation\`, \`.annotation-label\`, \`.new-section\`,
\`.detail-layout\`, \`.detail-main\`, \`.detail-side\`

Respond ONLY with the JSON fenced block — no other text.

\`\`\`json
{
  "decision": "new-page" | "update-page" | "no-ui",
  "rationale": "One sentence describing exactly what you changed (e.g. 'Added a sort button to the toolbar; rest of mock unchanged.').",
  "targetPageRoute": "/path" | null,
  "targetPageTitle": "Explicit page name" | null,
  "targetPageSubTabs": ["Tab One"] | [],
  "targetSubTabActive": "Tab One" | null,
  "mockHtml": "<div>...preserved HTML with targeted edits...</div>" | null
}
\`\`\``;
}

/* ── Bedrock invocation ───────────────────────────────────── */

interface ImageInput {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}

/**
 * Thrown when Bedrock returns `stop_reason: 'max_tokens'`, meaning the response
 * was cut off before completion. This is distinct from a refusal — the model
 * was producing valid output but ran out of room.
 */
export class BedrockModelTruncatedError extends Error {
  constructor(public readonly modelText: string, public readonly maxTokens: number) {
    super(
      `Model response was truncated at ${maxTokens} output tokens. ` +
      `Increase BEDROCK_UI_MOCK_MAX_TOKENS or use a more concise prompt.`
    );
    this.name = 'BedrockModelTruncatedError';
  }
}

/**
 * Invoke Claude on Bedrock.
 * When `image` is provided the call is multimodal — the image is prepended
 * to the message so Claude can visually ground its output.
 *
 * @param modelId   Optional override; defaults to the shared MODEL_ID. UI-mock
 *                  generation passes UI_MOCK_MODEL_ID so it can run on a
 *                  different model than backlog generation.
 * @param maxTokens Max output tokens. Defaults to 4096 (sized for backlog
 *                  generation). UI mock calls pass a much higher value because
 *                  HTML mocks are far larger than JSON-only backlog responses.
 */
async function invokeModel(
  prompt: string,
  image?: ImageInput,
  modelId: string = MODEL_ID,
  maxTokens: number = 4096,
  timeoutMs?: number,
): Promise<string> {
  const textBlock = { type: 'text', text: prompt };

  const content: unknown[] = image
    ? [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: image.mediaType,
            data: image.base64,
          },
        },
        textBlock,
      ]
    : [textBlock];

  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };

  const command = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  });

  // Each attempt is bounded by MODEL_INVOKE_TIMEOUT_MS. Throttling/5xx are retried
  // with exponential backoff + jitter (Bedrock throttles concurrent large calls
  // hard); the abort-timeout and truncation are NOT retried (see predicate).
  const response = await retryWithBackoff(
    async () => {
      const effectiveTimeout = timeoutMs ?? MODEL_INVOKE_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        return await client.send(command, { abortSignal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new Error(
            `Bedrock request timed out after ${Math.round(effectiveTimeout / 1000)}s (model=${modelId}). The generation was aborted.`,
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      maxRetries: MODEL_INVOKE_MAX_ATTEMPTS,
      initialDelay: 2000,
      jitter: true,
      shouldRetry: isBedrockThrottleError,
    },
  );
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ type: string; text: string }>;
    stop_reason?: string;
  };

  const text = body.content[0]?.text ?? '';

  // Bedrock signals truncation via stop_reason. Surface this as a dedicated
  // error so callers / API routes can return an actionable message.
  if (body.stop_reason === 'max_tokens') {
    console.warn(
      `[bedrockService] Response truncated at max_tokens=${maxTokens} ` +
      `(model=${modelId}). Output length: ${text.length} chars.`
    );
    throw new BedrockModelTruncatedError(text, maxTokens);
  }

  return text;
}

function parseUiMockResult(
  text: string,
  catalog: DesignSystemCatalog,
  /** When provided, locked fields are overridden from the plan regardless of model output. */
  featurePlan?: UiSurfacePlan
): UiMockResult {
  const parsed = JSON.parse(extractJson(text, 'UiMock')) as Record<string, unknown>;

  const validDecisions: UiMockDecision[] = ['new-page', 'update-page', 'no-ui'];
  let decision: UiMockDecision = validDecisions.includes(parsed.decision as UiMockDecision)
    ? (parsed.decision as UiMockDecision)
    : 'no-ui';

  let targetPageRoute = typeof parsed.targetPageRoute === 'string' ? parsed.targetPageRoute : undefined;
  let targetPageTitle = typeof parsed.targetPageTitle === 'string' ? parsed.targetPageTitle : undefined;
  let targetPageSubTabs = Array.isArray(parsed.targetPageSubTabs)
    ? (parsed.targetPageSubTabs as string[])
    : [];
  const targetSubTabActive = typeof parsed.targetSubTabActive === 'string' ? parsed.targetSubTabActive : undefined;

  /* Defensive overrides — if a plan was supplied, locked fields win over model output.
     This prevents the model from inventing a different page even when the prompt is clear. */
  if (featurePlan) {
    decision = featurePlan.decision;
    if (featurePlan.targetPageRoute !== undefined) targetPageRoute = featurePlan.targetPageRoute;
    if (featurePlan.targetPageTitle !== undefined) targetPageTitle = featurePlan.targetPageTitle;
    // Sub-tabs: use plan's unless the model added a new-tab contribution (which adds a tab)
    if (featurePlan.subTabs.length > 0) {
      // Accept any extra tabs the model produced that aren't already in the plan
      const extraTabs = targetPageSubTabs.filter(t => !featurePlan.subTabs.includes(t));
      targetPageSubTabs = [...featurePlan.subTabs, ...extraTabs];
    }
  }

  // Strip any leading <h1>/<h2> the model may have included despite instructions —
  // the shell already renders the page title above .mwx-content.
  const rawInner = typeof parsed.mockHtml === 'string' ? parsed.mockHtml : undefined;
  const innerHtml = rawInner
    ? rawInner.replace(/^\s*<h[12][^>]*>[\s\S]*?<\/h[12]>\s*/i, '')
    : undefined;

  /* Build the full MaxView shell around the inner content */
  let mockHtml: string | undefined;
  if (innerHtml && decision !== 'no-ui') {
    /* Prefer: 1) Figma reference nav (live design), 2) catalog routes (code scan),
       3) static defaults */
    const figmaRef = getFigmaReference();
    const navItems: Array<{ label: string; route: string; icon: string }> =
      figmaRef.navItems.length > 0
        ? figmaRef.navItems.map(n => ({ label: n.label, route: n.route, icon: n.icon ?? '⊡' }))
        : catalog.routes.length > 0
          ? catalog.routes.map(r => ({ label: r.title, route: r.path, icon: '⊡' }))
          : DEFAULT_NAV_ITEMS;

    const pageTitle = targetPageTitle
      ?? (targetPageRoute ? (navItems.find(n => n.route === targetPageRoute)?.label ?? targetPageRoute) : null)
      ?? (decision === 'new-page' ? 'New Page' : 'Page');

    mockHtml = buildMaxViewShell({
      navItems,
      activeRoute: targetPageRoute ?? null,
      newPageLabel: decision === 'new-page' ? (targetPageTitle ?? null) : null,
      subTabs: targetPageSubTabs,
      activeSubTab: targetSubTabActive ?? (targetPageSubTabs[0] ?? null),
      pageTitle,
      contentSlot: innerHtml,
    });
  }

  return {
    decision,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    targetPageRoute,
    targetPageTitle,
    targetPageSubTabs,
    targetSubTabActive,
    mockHtml,
  };
}

export async function generateUiMockFromBedrock(
  input: GenerateUiMockInput
): Promise<UiMockResult> {
  const skillContent = await loadSkillContent();
  const prompt = buildUiMockPrompt(input, skillContent);

  /* Pass the Figma reference screenshot as a vision input so Claude can
     visually match the real MaxView look and feel. */
  const ref = getFigmaReference();
  const image: ImageInput | undefined = ref.tablePageBase64
    ? {
        base64: ref.tablePageBase64,
        mediaType: 'image/png',
        width: ref.tablePageWidth,
        height: ref.tablePageHeight,
      }
    : undefined;

  const text = await invokeModel(prompt, image, UI_MOCK_MODEL_ID, UI_MOCK_MAX_TOKENS);
  return parseUiMockResult(text, input.catalog, input.featurePlan);
}

export async function regenerateUiMockFromBedrock(
  input: RegenerateUiMockInput
): Promise<UiMockResult> {
  const skillContent = await loadSkillContent();
  const prompt = buildRegenerateUiMockPrompt(input, skillContent);

  /* Include the visual reference on regeneration too so refinements
     stay visually consistent with the original design. */
  const ref = getFigmaReference();
  const image: ImageInput | undefined = ref.tablePageBase64
    ? {
        base64: ref.tablePageBase64,
        mediaType: 'image/png',
        width: ref.tablePageWidth,
        height: ref.tablePageHeight,
      }
    : undefined;

  const text = await invokeModel(prompt, image, UI_MOCK_MODEL_ID, UI_MOCK_MAX_TOKENS);
  return parseUiMockResult(text, input.catalog, input.featurePlan);
}

/**
 * Generate N parallel variant mocks for the same input by injecting one of the
 * VARIANT_HINTS into each call.  Results are returned in hint order (A, B, C, D).
 * Any individual failure is silently dropped unless ALL variants fail, in which
 * case the error from the first failure is re-thrown.
 *
 * @param input  Base generation input (variantHint must NOT be pre-set — it is
 *               set internally per variant).
 * @param count  Number of variants to generate (clamped to 1–4).
 */
export async function generateUiMockVariantsFromBedrock(
  input: GenerateUiMockInput,
  count: number
): Promise<UiMockResult[]> {
  const n = Math.max(1, Math.min(4, Math.floor(count)));
  const hints = VARIANT_HINTS.slice(0, n);

  const results = await Promise.allSettled(
    hints.map(({ hint }) =>
      generateUiMockFromBedrock({ ...input, variantHint: hint })
    )
  );

  const successes: UiMockResult[] = [];
  let firstError: unknown = null;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      successes.push(result.value);
    } else {
      console.warn('[bedrockService] Variant generation failed:', result.reason);
      if (firstError === null) firstError = result.reason;
    }
  }

  if (successes.length === 0) {
    throw firstError ?? new Error('All variant generations failed');
  }

  return successes;
}

/* ════════════════════════════════════════════════════════════
   UI SURFACE PLAN GENERATION
   ════════════════════════════════════════════════════════════ */

function buildUiPlanPrompt(input: GenerateUiPlanInput): string {
  const catalogSection = buildCatalogSection(input.catalog);

  const pbisSection = input.childPbis.length > 0
    ? `## Child PBIs\n\n${input.childPbis.map(p => {
        const ac = p.acceptanceCriteria?.length
          ? `\n  Acceptance criteria:\n${p.acceptanceCriteria.map(a => `  - ${a}`).join('\n')}`
          : '';
        return `- **${p.pbiTitle}** (id: \`${p.pbiId}\`)${p.description ? `\n  ${p.description}` : ''}${ac}`;
      }).join('\n\n')}`
    : '';

  const siblingFeaturesSection = input.siblingFeatures?.length
    ? `## Sibling features under the same epic\n\n${input.siblingFeatures.map(f =>
        `- **${f.title}**${f.description ? `: ${f.description}` : ''}`
      ).join('\n')}\n\n`
    : '';

  const epicPlanSection = input.epicPlan
    ? `## Parent epic UI surface plan (pre-established — align with this)\n\n\`\`\`json\n${JSON.stringify(input.epicPlan, null, 2)}\n\`\`\`\n\nYour feature plan must:\n- Use the same \`decision\`, \`targetPageRoute\`, \`targetPageTitle\`, and \`subTabs\` unless the epic plan is clearly insufficient for this feature.\n- Extend \`pbiContributions\` only for the PBIs belonging to **this feature**.\n\n`
    : '';

  // Build the sibling surface lock section — the most important constraint:
  // if other features already own this route, this plan must be a pure delta.
  const existingSurfaceSection = input.existingSurfacePlans?.length
    ? (() => {
        const plans = input.existingSurfacePlans!;
        const lockedPlan = plans[0].plan; // use the first (canonical) plan's surface values

        const otherFeaturesSummary = plans.map(p =>
          `- **${p.featureTitle}**: ${p.plan.pbiContributions.map(c => c.summary).join('; ') || 'contributions pending'}`
        ).join('\n');

        return `## ⚠️ EXISTING SURFACE — DO NOT RE-PLAN THE PAGE STRUCTURE

The following sibling feature(s) in this epic have **already established** a UI surface plan for **\`${lockedPlan.targetPageRoute ?? 'this page'}\`**. You MUST NOT change the surface structure. Your job is only to describe what THIS feature's PBIs add as deltas to the shared surface.

**Locked surface values — copy these verbatim into your output:**
\`\`\`json
${JSON.stringify({
  decision: lockedPlan.decision,
  targetPageRoute: lockedPlan.targetPageRoute ?? null,
  targetPageTitle: lockedPlan.targetPageTitle ?? null,
  subTabs: lockedPlan.subTabs,
  layoutPattern: lockedPlan.layoutPattern ?? null,
  primaryComponents: lockedPlan.primaryComponents,
}, null, 2)}
\`\`\`

**What other features already contribute to this surface:**
${otherFeaturesSummary}

**Your only task:** populate \`pbiContributions\` for THIS feature's PBIs — describe each PBI's additive delta (new section, new tab, action, filter, etc.) without touching or duplicating what the features above already deliver. Keep \`decision\`, \`targetPageRoute\`, \`targetPageTitle\`, \`subTabs\`, and \`layoutPattern\` exactly as shown in the locked values above.

---

`;
      })()
    : '';

  const additionalSection = input.additionalContext?.trim()
    ? `## Additional context from BA/UX\n\n${input.additionalContext.trim()}\n\n`
    : '';

  const validDecisions = ['new-page', 'update-page', 'no-ui'];
  const validLayouts: UiLayoutPattern[] = ['table', 'calendar', 'dashboard', 'form', 'detail-page', 'wizard', 'modal', 'drawer', 'widget'];
  const validContributions: PbiContributionType[] = ['new-section', 'new-tab', 'table-column', 'filter', 'action', 'state', 'modal', 'drawer', 'no-ui'];

  const ref = getFigmaReference();
  const navItemsForRouteList = ref.navItems.length > 0 ? ref.navItems : DEFAULT_NAV_ITEMS;
  const validRoutes = input.catalog.routes.length > 0
    ? input.catalog.routes.map(r => `"${r.path}"`)
    : navItemsForRouteList.map(n => `"${n.route}"`);

  // When existing surface plans are present, the decision/route/layout rules change
  const routingRules = input.existingSurfacePlans?.length
    ? `- The surface structure is LOCKED (see "EXISTING SURFACE" block above). Copy the locked values exactly.
- Only populate \`pbiContributions\` with deltas specific to this feature's PBIs.
- Do NOT add sub-tabs that are already listed in the locked \`subTabs\` array.`
    : `- Use the "Existing screens — detailed descriptions" section to understand what each current page covers before deciding new-page vs update-page.
- A "new-page" means a brand-new left-nav entry is warranted. Be conservative — prefer update-page.
- "no-ui" means entirely backend/infra work with zero user-facing change.
- \`targetPageRoute\` must be one of the valid routes: ${validRoutes.join(', ')} (or null for new-page/no-ui).
- \`layoutPattern\` must be one of: ${validLayouts.map(l => `"${l}"`).join(', ')}.`;

  return `You are a senior UX architect and product analyst for MaxView — a workforce management web application used by healthcare staffing agencies.

${catalogSection}${epicPlanSection}${existingSurfaceSection}${siblingFeaturesSection}## ${input.scope === 'epic' ? 'Epic' : 'Feature'} to plan

**${input.scope === 'epic' ? 'Epic' : 'Feature'}:** "${input.title}"
${input.epicTitle && input.scope === 'feature' ? `**Epic:** "${input.epicTitle}"\n` : ''}${input.description ? `**Description:**\n${input.description}\n` : ''}

${pbisSection}

${additionalSection}## Your task

${input.existingSurfacePlans?.length
  ? `Produce a **UI Surface Plan** that adds this feature's PBI contributions as deltas to the already-established surface (see "EXISTING SURFACE" block above). Do NOT re-design the page structure.`
  : `Produce a **UI Surface Plan** — a structured JSON document that specifies which existing MaxView page (or new page) will host this ${input.scope}'s functionality, the layout pattern, the page structure, and exactly how each child PBI contributes as a delta to that shared surface.`
}

Rules:
${routingRules}
- \`targetPageRoute\` must be one of the valid routes: ${validRoutes.join(', ')} (or null for new-page/no-ui).
- \`primaryComponents\` should list MWx Design System component names (from existing components list) that best represent this surface.
- For each PBI, specify \`contributionType\` (one of: ${validContributions.map(c => `"${c}"`).join(', ')}) and \`targetArea\` (the specific area of the page, e.g. "toolbar", "row actions", "new tab: Recurring Requests").
- \`summary\` for each PBI is one sentence describing the delta only.

## Output (JSON only)

\`\`\`json
{
  "scope": "${input.scope}",
  "decision": ${validDecisions.map(d => `"${d}"`).join(' | ')},
  "targetPageRoute": "/existing-route" | null,
  "targetPageTitle": "Human-readable page title" | null,
  "subTabs": ["Tab One", "Tab Two"] | [],
  "activeSubTab": "Tab One" | null,
  "layoutPattern": "table" | "calendar" | "dashboard" | "form" | "detail-page" | "wizard" | "modal" | "drawer" | "widget" | null,
  "primaryComponents": ["ComponentName", ...],
  "rationale": "Two or three sentences explaining the decision and layout choice.",
  "pbiContributions": [
    {
      "pbiId": "<id>",
      "pbiTitle": "<title>",
      "contributionType": "new-section" | "new-tab" | "table-column" | "filter" | "action" | "state" | "modal" | "drawer" | "no-ui",
      "targetArea": "<specific area on the page>",
      "summary": "<one sentence delta description>"
    }
  ]
}
\`\`\`

Rules:
- \`targetPageRoute\` is null for "no-ui" and for "new-page".
- Every child PBI must have exactly one entry in \`pbiContributions\`.
- Respond ONLY with the JSON fenced block — no other text.`;
}

function parseUiPlanResult(text: string): UiSurfacePlan {
  const parsed = JSON.parse(extractJson(text, 'UiPlan')) as Record<string, unknown>;

  const validDecisions: UiMockDecision[] = ['new-page', 'update-page', 'no-ui'];
  const decision: UiMockDecision = validDecisions.includes(parsed.decision as UiMockDecision)
    ? (parsed.decision as UiMockDecision)
    : 'no-ui';

  const validLayouts: UiLayoutPattern[] = ['table', 'calendar', 'dashboard', 'form', 'detail-page', 'wizard', 'modal', 'drawer', 'widget'];
  const layoutPattern = validLayouts.includes(parsed.layoutPattern as UiLayoutPattern)
    ? (parsed.layoutPattern as UiLayoutPattern)
    : undefined;

  const validContributions: PbiContributionType[] = ['new-section', 'new-tab', 'table-column', 'filter', 'action', 'state', 'modal', 'drawer', 'no-ui'];

  const pbiContributions: PbiContribution[] = Array.isArray(parsed.pbiContributions)
    ? (parsed.pbiContributions as any[]).map(c => ({
        pbiId: typeof c.pbiId === 'string' ? c.pbiId : '',
        pbiTitle: typeof c.pbiTitle === 'string' ? c.pbiTitle : '',
        contributionType: validContributions.includes(c.contributionType) ? c.contributionType as PbiContributionType : 'new-section',
        targetArea: typeof c.targetArea === 'string' ? c.targetArea : 'main content',
        summary: typeof c.summary === 'string' ? c.summary : '',
      }))
    : [];

  const now = new Date().toISOString();
  return {
    scope: parsed.scope === 'epic' ? 'epic' : 'feature',
    decision,
    targetPageRoute: typeof parsed.targetPageRoute === 'string' ? parsed.targetPageRoute : undefined,
    targetPageTitle: typeof parsed.targetPageTitle === 'string' ? parsed.targetPageTitle : undefined,
    subTabs: Array.isArray(parsed.subTabs) ? (parsed.subTabs as string[]) : [],
    activeSubTab: typeof parsed.activeSubTab === 'string' ? parsed.activeSubTab : undefined,
    layoutPattern,
    primaryComponents: Array.isArray(parsed.primaryComponents) ? (parsed.primaryComponents as string[]) : [],
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    pbiContributions,
    planVersion: 1,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

export async function generateUiPlanFromBedrock(
  input: GenerateUiPlanInput
): Promise<UiSurfacePlan> {
  const prompt = buildUiPlanPrompt(input);
  const text = await invokeModel(prompt, undefined, UI_MOCK_MODEL_ID, UI_MOCK_MAX_TOKENS);
  return parseUiPlanResult(text);
}

/**
 * Synthesise a transient UiSurfacePlan from an existing feature.uiMock.
 * Used for backward compatibility when a feature has mocks but no explicit plan.
 * The result is NOT persisted — callers may persist it if the user chooses.
 */
export function synthesisePlanFromUiMock(
  featureId: string,
  featureTitle: string,
  uiMock: {
    decision: UiMockDecision;
    targetPageRoute?: string;
    targetPageTitle?: string;
    targetPageSubTabs?: string[];
    views?: Array<{ pbiId: string; pbiTitle: string }>;
  }
): UiSurfacePlan {
  const now = new Date().toISOString();
  return {
    scope: 'feature',
    decision: uiMock.decision,
    targetPageRoute: uiMock.targetPageRoute,
    targetPageTitle: uiMock.targetPageTitle,
    subTabs: uiMock.targetPageSubTabs ?? [],
    primaryComponents: [],
    rationale: `Synthesised from existing UI mock for feature "${featureTitle}".`,
    pbiContributions: (uiMock.views ?? []).map(v => ({
      pbiId: v.pbiId,
      pbiTitle: v.pbiTitle,
      contributionType: 'new-section' as PbiContributionType,
      targetArea: 'main content',
      summary: `Renders the ${v.pbiTitle} section within ${uiMock.targetPageTitle ?? 'this page'}.`,
    })),
    planVersion: 1,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

/* ════════════════════════════════════════════════════════════
   PRD FIX-WITH-AI
   ════════════════════════════════════════════════════════════ */

export interface PrdCommentReply {
  authorName?: string;
  body: string;
}

export interface PrdComment {
  sectionKey?: string | null;
  exact?: string | null;
  body: string;
  authorName?: string;
  replies?: PrdCommentReply[];
}

function formatCommentsForPrompt(comments: PrdComment[]): string {
  return comments
    .map((c, i) => {
      const parts: string[] = [`### Comment ${i + 1}`];
      if (c.authorName) parts.push(`Reviewer: ${c.authorName}`);
      if (c.exact) parts.push(`Highlighted text (MUST be the focus of this fix): "${c.exact}"`);
      parts.push(`Feedback: ${c.body}`);
      if (c.replies && c.replies.length > 0) {
        parts.push('Thread replies (often contain specific fix instructions):');
        for (const reply of c.replies) {
          const prefix = reply.authorName ? `${reply.authorName}: ` : '';
          parts.push(`  - ${prefix}${reply.body}`);
        }
      }
      return parts.join('\n');
    })
    .join('\n\n');
}

/**
 * Apply open review comments to a PRD and return the revised markdown.
 * Calls Bedrock once — returns the full updated PRD content as a string.
 */
export async function fixPrdContentWithBedrock(
  prdContent: string,
  comments: PrdComment[],
  modelId?: string | null,
  maxTokens?: number | null,
): Promise<string> {
  const commentLines = formatCommentsForPrompt(comments);

  const prompt = `You are a senior product owner. Revise the PRD below to address every review comment listed.

## Current PRD Content

${prdContent || '(empty)'}

## Review Comments to Address

${commentLines}

## Instructions

- Each comment has a "Highlighted text" field — this is the EXACT passage the reviewer selected. Your fix MUST target that specific text. Do not make unrelated changes elsewhere.
- Pay close attention to thread replies — they often contain the specific wording or instructions for what to change.
- Produce the complete revised PRD as clean markdown.
- Only modify the passages referenced by the highlighted text. Keep all other content unchanged.
- Preserve all sections, heading levels, and overall structure unless a comment explicitly asks to change them.
- Do NOT add a preamble, summary, or explanation — output ONLY the revised markdown, starting directly with the first heading.`;

  const resolvedModel = modelId ?? MODEL_ID;
  const resolvedMaxTokens = (maxTokens != null && maxTokens > 0) ? maxTokens : UI_MOCK_MAX_TOKENS;
  const text = await invokeModel(prompt, undefined, resolvedModel, resolvedMaxTokens);

  const fenced = text.match(/```(?:markdown)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1].trim() : text.trim();
}

/**
 * Apply open review comments to a PRD backlog and return the revised backlog JSON.
 * Calls Bedrock once — returns the updated backlog as a parsed object.
 */
export async function fixPrdBacklogWithBedrock(
  backlogJson: unknown,
  comments: PrdComment[],
  modelId?: string | null,
  maxTokens?: number | null,
): Promise<unknown> {
  const commentLines = formatCommentsForPrompt(comments);
  const backlogStr = JSON.stringify(backlogJson, null, 2);

  const prompt = `You are a senior product owner. Revise the backlog JSON below to address every review comment listed.

## Current Backlog JSON

\`\`\`json
${backlogStr}
\`\`\`

## Review Comments to Address

${commentLines}

## Instructions

- Each comment has a "Highlighted text" field — this is the EXACT text the reviewer selected from the rendered backlog. Your fix MUST target that specific content (e.g. a specific epic title, feature description, user story, acceptance criteria, etc.). Do not make unrelated changes.
- Pay close attention to thread replies — they often contain the specific wording or instructions for what to change.
- Output ONLY the complete revised backlog as valid JSON (no markdown fences, no preamble, no explanation).
- Only modify the fields/items referenced by the highlighted text. Keep all other data unchanged.
- Preserve the exact same JSON structure and all existing fields.`;

  const resolvedModel = modelId ?? MODEL_ID;
  const resolvedMaxTokens = (maxTokens != null && maxTokens > 0) ? maxTokens : UI_MOCK_MAX_TOKENS;
  const text = await invokeModel(prompt, undefined, resolvedModel, resolvedMaxTokens);

  // Strip any accidental code fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const cleaned = fenced ? fenced[1].trim() : text.trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // If the model produces invalid JSON, fall back to returning null so caller knows it failed
    return null;
  }
}

/* ── Persona / user-type enrichment ───────────────────────────────────────── */

/**
 * Canonical user-type (persona) slug vocabulary. The Business Analyst speaks in
 * persona names during the interview (e.g. "external employee", "coder"); this
 * map is handed to the model so free-text persona names get normalised to the
 * stable slugs the design-prototype generator consumes.
 */
const USER_TYPE_SLUG_VOCABULARY = [
  'S = System Admin',
  'I = Internal',
  'C = Contact',
  'E = External',
  'CO = Coder',
  'Q = QR Scanner',
  'PA = Portal Admin',
  'SC = Subcontractor',
].join('\n');

const VALID_USER_TYPE_SLUGS = new Set(['S', 'I', 'C', 'E', 'CO', 'Q', 'PA', 'SC']);

interface PersonaBacklogItem {
  type?: string;
  workItemType?: string;
  title?: string;
  description?: string;
  affectedPersonas?: string[];
  userStory?: { persona?: string; iWant?: string; soThat?: string };
  items?: PersonaBacklogItem[];
  pbis?: PersonaBacklogItem[];
  userTypes?: string[];
  personaBehaviors?: Array<{ userTypes: string[]; behavior: string }>;
}

function isTbiBacklogItem(item: PersonaBacklogItem): boolean {
  return item.type === 'TBI' || item.workItemType === 'TBI';
}

interface PersonaBacklogShape {
  features?: PersonaBacklogItem[];
  epics?: Array<{ features?: PersonaBacklogItem[] }>;
}

interface PersonaNode {
  ref: string;
  kind: 'feature' | 'pbi';
  title: string;
  description?: string;
  affectedPersonas?: string[];
  userStory?: { persona?: string; iWant?: string; soThat?: string };
  target: PersonaBacklogItem;
}

interface PersonaAnnotation {
  userTypes?: unknown;
  personaBehaviors?: unknown;
}

/**
 * Walk a backlog (top-level `features` plus `epics[].features`) and return every
 * feature and PBI in a stable, deterministic order with a positional `ref` key.
 * The same order is produced for the original (prompt) and the clone (apply), so
 * annotations map back precisely without fragile title matching.
 */
function collectPersonaNodes(backlogJson: unknown): PersonaNode[] {
  const bj = backlogJson as PersonaBacklogShape | null;
  if (!bj || typeof bj !== 'object') return [];

  const features: PersonaBacklogItem[] = [];
  if (Array.isArray(bj.features)) features.push(...bj.features);
  if (Array.isArray(bj.epics)) {
    for (const epic of bj.epics) {
      if (Array.isArray(epic?.features)) features.push(...epic.features);
    }
  }

  const nodes: PersonaNode[] = [];
  features.forEach((feature, fi) => {
    if (!feature || typeof feature !== 'object') return;
    nodes.push({
      ref: `f${fi}`,
      kind: 'feature',
      title: feature.title ?? `Feature ${fi + 1}`,
      description: feature.description,
      affectedPersonas: feature.affectedPersonas,
      target: feature,
    });
    const items = feature.items ?? feature.pbis ?? [];
    items.forEach((item, pi) => {
      if (!item || typeof item !== 'object') return;
      if (isTbiBacklogItem(item)) return;
      nodes.push({
        ref: `f${fi}_p${pi}`,
        kind: 'pbi',
        title: item.title ?? `Item ${pi + 1}`,
        description: item.description,
        userStory: item.userStory,
        target: item,
      });
    });
  });
  return nodes;
}

/** Remove persona annotations from TBIs — only PBIs feed design prototypes. */
function stripTbiPersonaAnnotations(backlogJson: unknown): void {
  const bj = backlogJson as PersonaBacklogShape | null;
  if (!bj || typeof bj !== 'object') return;

  const features: PersonaBacklogItem[] = [];
  if (Array.isArray(bj.features)) features.push(...bj.features);
  if (Array.isArray(bj.epics)) {
    for (const epic of bj.epics) {
      if (Array.isArray(epic?.features)) features.push(...epic.features);
    }
  }

  for (const feature of features) {
    const items = feature.items ?? feature.pbis ?? [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || !isTbiBacklogItem(item)) continue;
      delete item.userTypes;
      delete item.personaBehaviors;
    }
  }
}

function sanitiseSlugList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const slug = raw.trim().toUpperCase();
    if (VALID_USER_TYPE_SLUGS.has(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

function sanitisePersonaBehaviors(input: unknown): Array<{ userTypes: string[]; behavior: string }> {
  if (!Array.isArray(input)) return [];
  const out: Array<{ userTypes: string[]; behavior: string }> = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { userTypes?: unknown; behavior?: unknown };
    const slugs = sanitiseSlugList(r.userTypes);
    const behavior = typeof r.behavior === 'string' ? r.behavior.trim() : '';
    if (slugs.length > 0 && behavior) out.push({ userTypes: slugs, behavior });
  }
  return out;
}

/**
 * Populate `userTypes` and `personaBehaviors` on every feature and PBI of a
 * synthesised backlog (TBIs are excluded — they do not feed design prototypes).
 * The Business Analyst knows which personas each feature
 * serves (and any "same control, different behaviour per persona group"
 * divergences); this pass maps that persona knowledge — surfaced in the backlog's
 * user stories, affected-personas, and descriptions, plus the optional interview
 * transcript — onto the canonical slug vocabulary the prototype generator reads.
 *
 * Routes are intentionally NOT touched here (handled by route inference). The
 * merge is non-destructive: annotations are applied to a deep clone, leaving the
 * backlog structure and all existing fields intact. Best-effort — returns the
 * original backlog unchanged on any failure, mirroring route inference.
 */
export async function enrichBacklogPersonasWithBedrock(
  backlogJson: unknown,
  modelId?: string | null,
  maxTokens?: number | null,
  interviewTranscript?: string | null,
): Promise<unknown> {
  if (!backlogJson || typeof backlogJson !== 'object') return backlogJson;

  const nodes = collectPersonaNodes(backlogJson);
  if (nodes.length === 0) return backlogJson;

  const itemsForPrompt = nodes.map(n => ({
    ref: n.ref,
    kind: n.kind,
    title: n.title,
    description: n.description || undefined,
    affectedPersonas: n.affectedPersonas?.length ? n.affectedPersonas : undefined,
    userStoryPersona: n.userStory?.persona || undefined,
  }));

  const transcriptSection = interviewTranscript?.trim()
    ? `\n## Interview transcript (the BA's own words about who each feature is for and any per-persona behaviour differences)\n\n${interviewTranscript.trim().slice(0, 24000)}\n`
    : '';

  const prompt = `You are a senior product owner mapping each backlog item to the user types (personas) it serves.

## Canonical user-type slugs (map every persona name to one of these EXACT slugs)

${USER_TYPE_SLUG_VOCABULARY}

Map free-text persona names the team uses to the closest slug — e.g. "external employee" → E, "coder" → CO, "system administrator" → S, "internal staff" → I, "subcontractor" → SC, "portal admin" → PA, "QR scanner" → Q, "contact" → C.

## Backlog items to annotate

\`\`\`json
${JSON.stringify(itemsForPrompt, null, 2)}
\`\`\`
${transcriptSection}
## Instructions

- For EACH item "ref", decide which user types it serves and return them as "userTypes": an array of the canonical slugs above. Infer from the user-story persona, affectedPersonas, description, and the interview transcript.
- When the SAME control/screen behaves DIFFERENTLY for different persona groups (e.g. a Timecards button that does action A for S/I/C but action B for E/CO), capture each divergent group in "personaBehaviors": an array of { "userTypes": [...slugs], "behavior": "what the control does for this group" }. Omit "personaBehaviors" entirely when behaviour does not diverge by persona.
- Only include slugs you have real evidence for. If an item's audience is genuinely unclear, return an empty "userTypes" array for it.
- Do NOT invent routes or any other fields. Routes are handled separately.
- Output ONLY a JSON object keyed by each item "ref" — no markdown fences, no preamble, no explanation:

{
  "f0": { "userTypes": ["S", "I"], "personaBehaviors": [{ "userTypes": ["E", "CO"], "behavior": "..." }] },
  "f0_p0": { "userTypes": ["S"] }
}`;

  const resolvedModel = modelId ?? MODEL_ID;
  const resolvedMaxTokens = (maxTokens != null && maxTokens > 0) ? maxTokens : UI_MOCK_MAX_TOKENS;

  let text: string;
  try {
    text = await invokeModel(prompt, undefined, resolvedModel, resolvedMaxTokens);
  } catch (err) {
    console.warn('[bedrockService] enrichBacklogPersonas: model call failed — leaving backlog unchanged', err);
    return backlogJson;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const cleaned = fenced ? fenced[1].trim() : text.trim();

  let annotations: Record<string, PersonaAnnotation>;
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return backlogJson;
    annotations = parsed as Record<string, PersonaAnnotation>;
  } catch {
    console.warn('[bedrockService] enrichBacklogPersonas: could not parse model output — leaving backlog unchanged');
    return backlogJson;
  }

  // Apply annotations onto a deep clone so the original is never mutated.
  const enriched = JSON.parse(JSON.stringify(backlogJson));
  const enrichedNodes = collectPersonaNodes(enriched);
  let annotated = 0;
  for (const node of enrichedNodes) {
    const ann = annotations[node.ref];
    if (!ann) continue;
    const slugs = sanitiseSlugList(ann.userTypes);
    if (slugs.length > 0) node.target.userTypes = slugs;
    const behaviors = sanitisePersonaBehaviors(ann.personaBehaviors);
    if (behaviors.length > 0) node.target.personaBehaviors = behaviors;
    if (slugs.length > 0 || behaviors.length > 0) annotated += 1;
  }

  if (annotated > 0) {
    console.log(`[bedrockService] enrichBacklogPersonas: annotated ${annotated} item(s) with user types`);
  }
  stripTbiPersonaAnnotations(enriched);
  return enriched;
}

/**
 * Apply open review comments to a single design-doc section and return the revised markdown.
 * Calls Bedrock once — returns the full updated section content as a string.
 */
export async function fixDesignDocSectionWithBedrock(
  sectionContent: string,
  sectionName: string,
  comments: PrdComment[],
  modelId?: string | null,
  maxTokens?: number | null,
): Promise<string> {
  const commentLines = formatCommentsForPrompt(comments);

  const prompt = `You are a senior technical architect. Revise the design document section below to address every review comment listed.

## Current ${sectionName} Content

${sectionContent || '(empty)'}

## Review Comments to Address

${commentLines}

## Instructions

- Each comment has a "Highlighted text" field — this is the EXACT passage the reviewer selected. Your fix MUST target that specific text. Do not make unrelated changes elsewhere.
- Pay close attention to thread replies — they often contain the specific wording or instructions for what to change.
- Produce the complete revised section as clean markdown.
- Only modify the passages referenced by the highlighted text. Keep all other content unchanged.
- Preserve all subsections, heading levels, and overall structure unless a comment explicitly asks to change them.
- Do NOT add a preamble, summary, or explanation — output ONLY the revised markdown, starting directly with the first heading or content.`;

  const resolvedModel = modelId ?? MODEL_ID;
  const resolvedMaxTokens = (maxTokens != null && maxTokens > 0) ? maxTokens : UI_MOCK_MAX_TOKENS;
  const text = await invokeModel(prompt, undefined, resolvedModel, resolvedMaxTokens);

  const fenced = text.match(/```(?:markdown)?\s*([\s\S]*?)\s*```/);
  return fenced ? fenced[1].trim() : text.trim();
}

/* ════════════════════════════════════════════════════════════
   DESIGN PLAN GENERATION (cheap structured plan, edited before HTML)
   ════════════════════════════════════════════════════════════ */

/** Default max tokens for the cheap JSON design-plan call when no project setting is configured. */
const DESIGN_PLAN_MAX_TOKENS = 4000;

export interface DesignPlanGenerationPbi {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  userTypes?: string[];
}

export interface DesignPlanGenerationFeature {
  featureIndex: number;
  featureName: string;
  featureDescription?: string;
  /** Existing MaxView route this feature extends, if inferred at PRD sync. */
  targetRoute?: string;
  pbis: DesignPlanGenerationPbi[];
}

export interface GenerateDesignPlanInput {
  prdTitle?: string;
  features: DesignPlanGenerationFeature[];
}

function buildDesignPlanPrompt(input: GenerateDesignPlanInput, catalogSection: string, screensContextSection: string): string {
  const featuresSection = input.features.map((f) => {
    const pbis = f.pbis.length > 0
      ? f.pbis.map((p) => {
          const parts = [`  - **${p.title}**`];
          if (p.userTypes?.length) parts.push(`    Applies to user types: ${p.userTypes.join(', ')}`);
          if (p.description) parts.push(`    ${p.description}`);
          if (p.acceptanceCriteria) parts.push(`    Acceptance criteria: ${p.acceptanceCriteria}`);
          return parts.join('\n');
        }).join('\n')
      : '  (no PBIs listed)';
    return `### Feature ${f.featureIndex}: ${f.featureName}\n${f.featureDescription ? `${f.featureDescription}\n` : ''}${f.targetRoute ? `Suggested existing route to extend: \`${f.targetRoute}\`\n` : ''}PBIs:\n${pbis}`;
  }).join('\n\n');

  return `You are a senior UI/UX designer producing a **design plan** for a MaxView application PRD. This plan will be reviewed and edited by a UI/UX designer before any high-fidelity HTML prototype is generated. Write the plan in clear, plain English that a designer can understand and modify — not in developer jargon.

${catalogSection}${screensContextSection}
## PRD${input.prdTitle ? `: ${input.prdTitle}` : ''}

Produce one plan entry per feature below.

${featuresSection}

## Output (JSON only)

Respond with ONLY a JSON fenced block containing an array with one object per feature, in the same order, using the exact \`featureIndex\` values given above:

\`\`\`json
[
  {
    "featureIndex": 0,
    "featureName": "<echo the feature name>",
    "designBrief": "<MOST IMPORTANT — see instructions below>",
    "decision": "new-page" | "update-page" | "no-ui",
    "targetRoute": "/existing-route" | null,
    "targetPageTitle": "Human-readable page title" | null,
    "layoutPattern": "table" | "calendar" | "dashboard" | "form" | "detail-page" | "wizard" | "modal" | "drawer" | "widget" | null,
    "primaryComponents": ["ComponentName", ...],
    "states": ["default", "empty", "error", "loading"],
    "pbiContributions": [
      { "pbiTitle": "<title>", "contribution": "<one sentence on how this PBI appears in the UI>" }
    ],
    "rationale": "Two or three sentences explaining the design decisions.",
    "notes": ""
  }
]
\`\`\`

### designBrief — CRITICAL FIELD

The \`designBrief\` is the primary content of the plan. It is a multi-paragraph, plain-English description of the screen that a UI/UX designer will read, edit, and approve before prototypes are generated. The prototype generator will follow this brief as its authoritative source. Write it as if you are briefing a designer colleague:

1. **What the user sees:** Describe the page layout, the main content area, and every visible element — headers, tables, forms, cards, filters, buttons, empty states, etc. Be specific about placement (e.g. "a search bar at the top of the content area, followed by a data grid").
2. **Key interactions:** Explain what happens when the user clicks, types, selects, or submits. Describe modals, drawers, inline edits, or navigation that occurs.
3. **User flow:** Walk through the primary happy path and any important alternate flows (error handling, empty state, loading).
4. **Design decisions:** Explain which layout pattern you chose and why. Reference specific design system components by name where possible.
5. **Per-PBI mapping:** For each PBI, briefly explain how it manifests in the UI — which part of the screen, which interaction.

Use newlines (\\n) to separate paragraphs for readability. Aim for 150–300 words per feature. Do NOT use markdown headings — just plain text with paragraph breaks.

### Other rules
- \`targetRoute\` is null for "new-page" and "no-ui"; for "update-page" it MUST be one of the existing routes listed above.
- \`primaryComponents\` should reference MWx Design System component names from the catalog where possible.
- \`states\` should list the UI states worth designing (default/empty/error/loading is a good baseline).
- Every PBI of a feature must have exactly one entry in \`pbiContributions\`.
- Leave \`notes\` as an empty string.
- Respond ONLY with the JSON fenced block — no other text.`;
}

function parseDesignPlanResult(text: string, input: GenerateDesignPlanInput): DesignPlanFeature[] {
  const parsed = JSON.parse(extractJson(text, 'DesignPlan')) as unknown;
  const arr: any[] = Array.isArray(parsed) ? parsed : [];

  const validDecisions = ['new-page', 'update-page', 'no-ui'];
  const validLayouts: UiLayoutPattern[] = ['table', 'calendar', 'dashboard', 'form', 'detail-page', 'wizard', 'modal', 'drawer', 'widget'];

  return input.features.map((feature) => {
    const match = arr.find((e) => Number(e?.featureIndex) === feature.featureIndex)
      ?? arr[input.features.indexOf(feature)]
      ?? {};

    const decision = validDecisions.includes(match.decision) ? match.decision : 'new-page';
    const layoutPattern = validLayouts.includes(match.layoutPattern) ? match.layoutPattern as UiLayoutPattern : undefined;

    const pbiContributions = Array.isArray(match.pbiContributions) && match.pbiContributions.length > 0
      ? match.pbiContributions.map((c: any) => ({
          pbiTitle: typeof c?.pbiTitle === 'string' ? c.pbiTitle : '',
          contribution: typeof c?.contribution === 'string' ? c.contribution : '',
        }))
      : feature.pbis.map((p) => ({ pbiTitle: p.title, contribution: '' }));

    const states = Array.isArray(match.states) && match.states.length > 0
      ? (match.states as unknown[]).filter((s): s is string => typeof s === 'string')
      : ['default', 'empty', 'error', 'loading'];

    return {
      featureIndex: feature.featureIndex,
      featureName: feature.featureName,
      designBrief: typeof match.designBrief === 'string' ? match.designBrief : '',
      decision,
      targetRoute: typeof match.targetRoute === 'string' && match.targetRoute.trim() ? match.targetRoute : undefined,
      targetPageTitle: typeof match.targetPageTitle === 'string' && match.targetPageTitle.trim() ? match.targetPageTitle : undefined,
      layoutPattern,
      primaryComponents: Array.isArray(match.primaryComponents)
        ? (match.primaryComponents as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
      states,
      pbiContributions,
      rationale: typeof match.rationale === 'string' ? match.rationale : '',
      notes: typeof match.notes === 'string' ? match.notes : '',
    };
  });
}

/**
 * Generate a cheap, structured design plan (one entry per feature) from PRD backlog features.
 * Output is JSON, not HTML — model/token budget come from the caller (project settings).
 */
export async function generateDesignPlanForPrd(
  input: GenerateDesignPlanInput,
  modelId?: string,
  maxTokens?: number,
): Promise<DesignPlanFeature[]> {
  const designSystemService = await import('./designSystemService');
  const catalog = await designSystemService.getDesignSystemCatalog();
  const catalogSection = buildCatalogSection(catalog);

  let screenInventory: ScreenInventoryRoute[] = [];
  try {
    screenInventory = await designSystemService.getScreenInventory();
  } catch (err) {
    console.warn('[bedrockService] getScreenInventory failed for design plan:', err);
  }
  const screensContextSection = buildScreensContextSection(screenInventory);

  const prompt = buildDesignPlanPrompt(input, catalogSection, screensContextSection);
  const effectiveModel = modelId ?? UI_MOCK_MODEL_ID;
  const effectiveMaxTokens = (maxTokens != null && maxTokens > 0) ? maxTokens : DESIGN_PLAN_MAX_TOKENS;
  const text = await invokeModel(prompt, undefined, effectiveModel, effectiveMaxTokens);
  return parseDesignPlanResult(text, input);
}

/* ════════════════════════════════════════════════════════════
   DESIGN PROTOTYPE GENERATION (Claude Design POC)
   ════════════════════════════════════════════════════════════ */

export interface DesignPrototypeInput {
  featureName: string;
  featureDescription?: string;
  pbis: Array<{
    title: string;
    description?: string;
    acceptanceCriteria?: string;
    /** User-type slugs (e.g. S/I/C/E/CO) this PBI applies to. */
    userTypes?: string[];
    /** Same control, different behavior per persona group. */
    personaBehaviors?: Array<{ userTypes: string[]; behavior: string }>;
  }>;
  /** Route of an existing MaxView page this feature extends. When set, EXTEND mode is used. */
  targetRoute?: string;
  /** Pre-fetched existing page code/structure text. When omitted in EXTEND mode it is fetched. */
  existingPageContext?: string;
  /**
   * Authoritative design-plan decisions for this feature (from the reviewed/edited design plan).
   * When present, these override the model's own inference for layout/components/states.
   */
  plan?: {
    designBrief?: string;
    decision?: string;
    layoutPattern?: string;
    targetPageTitle?: string;
    primaryComponents?: string[];
    states?: string[];
    pbiContributions?: Array<{ pbiTitle: string; contribution: string }>;
    rationale?: string;
    notes?: string;
  };
}

export async function generateDesignPrototypeHtml(
  input: DesignPrototypeInput,
  modelId?: string,
  maxTokens?: number,
  timeoutMs?: number,
): Promise<string> {
  const designSystemService = await import('./designSystemService');
  const catalog = await designSystemService.getDesignSystemCatalog();
  const catalogSection = buildCatalogSection(catalog);

  // Pull the screen inventory (route → purpose → user types → states) so the model has
  // persona/state context for the existing pages. Non-fatal: empty when unavailable.
  let screenInventory: ScreenInventoryRoute[] = [];
  try {
    screenInventory = await designSystemService.getScreenInventory();
  } catch (err) {
    console.warn('[bedrockService] getScreenInventory failed for design prototype:', err);
  }
  const screensContextSection = buildScreensContextSection(screenInventory);

  const ref = getFigmaReference();
  const image: ImageInput | undefined = ref.tablePageBase64
    ? { base64: ref.tablePageBase64, mediaType: 'image/png', width: ref.tablePageWidth, height: ref.tablePageHeight }
    : undefined;

  const pbiSection = input.pbis.map((pbi, i) => {
    const parts = [`### PBI ${i + 1}: ${pbi.title}`];
    if (pbi.userTypes?.length) parts.push(`**Applies to user types:** ${pbi.userTypes.join(', ')}`);
    if (pbi.description) parts.push(pbi.description);
    if (pbi.acceptanceCriteria) parts.push(`**Acceptance Criteria:**\n${pbi.acceptanceCriteria}`);
    if (pbi.personaBehaviors?.length) {
      const behaviors = pbi.personaBehaviors
        .map(pb => `- For user types ${pb.userTypes.join(', ')}: ${pb.behavior}`)
        .join('\n');
      parts.push(`**Per-persona behavior:** (same control, different behavior per persona group — render one variant per group; do not collapse)\n${behaviors}`);
    }
    return parts.join('\n');
  }).join('\n\n');

  // EXTEND mode: when the feature targets an existing page, fetch that page's actual
  // code (unless supplied) and reproduce it faithfully instead of using a generic shell.
  // The feature text guides the resolver's deep import traversal toward the relevant
  // sub-views (e.g. an in-page snapshot/modal) rather than just the top-level page.
  let existingPageContext = input.existingPageContext;
  if (input.targetRoute && !existingPageContext) {
    try {
      const { fetchExistingPageContext } = await import('./designSystemService');
      const featureText = [
        input.featureName,
        input.featureDescription,
        ...input.pbis.flatMap(p => [p.title, p.description, p.acceptanceCriteria]),
      ].filter(Boolean).join(' ');
      existingPageContext = await fetchExistingPageContext(input.targetRoute, featureText);
    } catch (err) {
      console.warn(`[bedrockService] fetchExistingPageContext failed for ${input.targetRoute}:`, err);
    }
  }
  const extendMode = Boolean(input.targetRoute && existingPageContext?.trim());

  // EXTEND mode: surface the target screen's personas/states from the inventory (when known).
  const targetScreen = input.targetRoute
    ? screenInventory.find(s => inventoryRouteMatches(s.route, input.targetRoute!))
    : undefined;
  const targetScreenHint = extendMode && (targetScreen?.userTypes?.length || targetScreen?.states)
    ? `\n\n**Existing page context from inventory:**` +
      (targetScreen?.userTypes?.length ? `\n- Serves user types: ${targetScreen.userTypes.join(', ')}` : '') +
      (targetScreen?.states ? `\n- Known UI states: ${targetScreen.states}` : '')
    : '';

  const scopingSection = extendMode
    ? `### CRITICAL SCOPING RULE — EXTEND an existing page; show the new feature IN CONTEXT
${targetScreenHint}
Below this section is the **ACTUAL code of the existing MaxView page** at \`${input.targetRoute}\`. You must:
1. **Reproduce the existing page layout faithfully** — its structure, sections, components, toolbars, tables/grids, and styling — as rendered HTML/CSS. Do NOT strip, omit, or simplify existing page elements. This reproduction is ONLY for visual context in the prototype — it does NOT mean the existing code should be rewritten or replaced.
2. **Add the new feature** described in the PBI Requirements, placed in the **correct location within the real page** (e.g. the toolbar, the data grid, the relevant panel/section where it logically belongs). The new feature MUST be clearly wrapped in the purple dashed annotation border so reviewers can instantly distinguish it from existing page elements.
3. **DO NOT invent, fabricate, or hallucinate** UI elements that are neither in the existing page code nor described in the PBI Requirements.
4. **The four state sections (default / empty / error / loading) apply ONLY to the NEW feature within the real page** — the rest of the existing page remains identical across all sections.
5. **IMPORTANT — Existing code is READ-ONLY context.** The existing page code below is provided ONLY so the prototype can show the new feature in its real visual context. When this prototype is later used to generate a design doc and implementation code, ONLY the new feature (the annotated area) should be implemented. The existing page code MUST NOT be modified, replaced, or restructured — it already exists and works correctly in the codebase.

## Existing Page Code (route: ${input.targetRoute})

${existingPageContext}`
    : `### CRITICAL SCOPING RULE — ONLY render what is described; NEVER invent content

You must follow these rules with zero exceptions:
1. **DO NOT invent, fabricate, or hallucinate any UI elements** that are not explicitly mentioned in the PBI Requirements or the feature description above. If a card, widget, table, chart, or section is not described in the requirements, it MUST NOT appear.
2. **The page shell consists of ONLY**: the MaxView left sidebar nav (with the standard role-gated nav items: Home, Companies, Worksites, Users, Shift Scheduler, RTO Management, Coder, Credentials, Document Management, Timecards, Admin Portal, Power BI — only those visible to the relevant persona) and the top header bar (with "Hello, [Name]" + avatar). These are the ONLY existing elements you render. The sidebar and header are shown ONLY for visual context — they are existing shared components that MUST NOT be modified in any downstream implementation.
3. **The content area must contain ONLY the new feature component** described in the PBI Requirements. Do not add other cards, widgets, summaries, charts, schedules, or any content that is not part of this feature.
4. **States apply ONLY to the new feature component** — the sidebar and header remain unchanged across all four sections.
5. **IMPORTANT — The sidebar, header, and page shell are READ-ONLY visual context.** They are rendered in the prototype purely for visual fidelity. When this prototype is used to generate a design doc and implementation code, ONLY the new feature component should be implemented. The sidebar navigation, header bar, and page layout MUST NOT be modified or regenerated — they already exist in the codebase.`;

  const plan = input.plan;
  const hasPlan = Boolean(
    plan && (plan.designBrief || plan.decision || plan.layoutPattern || plan.primaryComponents?.length || plan.states?.length || plan.rationale || plan.notes || plan.pbiContributions?.length),
  );

  let planSection = '';
  if (hasPlan) {
    const parts: string[] = [];
    parts.push('## Approved Design Brief (AUTHORITATIVE — follow exactly)');
    parts.push('');
    parts.push('A designer has reviewed and approved the following design brief for this feature. This brief is authoritative and **overrides any inference you would otherwise make**. Honor it precisely.');
    parts.push('');

    if (plan!.designBrief?.trim()) {
      parts.push(plan!.designBrief.trim());
      parts.push('');
    }

    const meta: string[] = [];
    if (plan!.decision) meta.push(`- **Decision:** ${plan!.decision}${plan!.decision === 'update-page' && input.targetRoute ? ` (extend the existing page at \`${input.targetRoute}\`)` : ''}`);
    if (plan!.targetPageTitle) meta.push(`- **Page title:** ${plan!.targetPageTitle}`);
    if (plan!.layoutPattern) meta.push(`- **Layout pattern:** ${plan!.layoutPattern}`);
    if (plan!.primaryComponents?.length) meta.push(`- **Primary components to use:** ${plan!.primaryComponents.join(', ')}`);
    if (plan!.states?.length) meta.push(`- **States to render:** ${plan!.states.join(', ')}`);
    if (plan!.rationale) meta.push(`- **Rationale:** ${plan!.rationale}`);
    if (plan!.notes?.trim()) meta.push(`- **Reviewer notes (must honor):** ${plan!.notes.trim()}`);
    if (meta.length) {
      parts.push('### Technical details');
      parts.push(...meta);
      parts.push('');
    }
    planSection = parts.join('\n');
  }

  const prompt = `You are a senior UI/UX designer generating a high-fidelity HTML prototype for a MaxView application feature.

${catalogSection}${screensContextSection}
## Feature to Design

**Feature:** ${input.featureName}
${input.featureDescription ? `**Description:** ${input.featureDescription}` : ''}

${planSection}## PBI Requirements

${pbiSection}

## Instructions

Generate a single, self-contained HTML document with inline CSS and inline JavaScript (no external dependencies). The document must show **four state sections** stacked vertically, each clearly separated.

### Color usage — STRICT (the MaxView Design Tokens are the ONLY color source)

- Use ONLY the colors from the "MaxView Design Tokens — colors" section above, chosen by **semantic role** (e.g. \`primary.main\` for primary actions, \`error.main\` for errors, \`success.main\` for success, \`warning.main\` for warnings, \`info.main\` for info, \`text.primary\`/\`text.secondary\` for text, \`background.paper\` for cards, \`ui.divider\` for borders/dividers).
- **NEVER invent, approximate, or sample** any hex/rgba value that is not listed in those tokens.
- The reference screenshot is provided for **layout and structure only** — do NOT pick colors from it. If its colors differ from the tokens, the tokens win.
- When reproducing existing page code that contains literal color values, **map each one to the nearest semantic token** instead of copying the raw value.
- The single exception is the dashed "NEW" annotation marker described below, which intentionally uses \`tertiary.main\` (#a46bff) so it stands out as a review-only overlay.

${scopingSection}

### Visual annotation of the new feature — PRECISE SCOPING

The purple annotation border MUST wrap ONLY the specific new UI element(s) being added — NOT the entire page, NOT the entire content area, NOT the existing page shell. Examples of correct annotation scoping:
- If adding a new **column** to an existing table/grid → wrap ONLY that column (header cell + data cells), not the entire table.
- If adding a new **tab** to an existing tab bar → wrap ONLY the new tab header and its tab content panel, not all existing tabs.
- If adding a new **section/panel** to an existing page → wrap ONLY that new section, not the surrounding existing sections.
- If adding a new **button or control** to an existing toolbar → wrap ONLY that button, not the entire toolbar.
- If adding a new **drawer/modal** → wrap ONLY the drawer/modal overlay, not the page behind it.

Apply a **2px dashed #a46bff border** (MaxView \`tertiary.main\`) with 8px padding around ONLY the new element(s). Add a small floating label at the top-left corner reading "NEW: ${input.featureName}" styled with background #a46bff, white text, 10px bold font, 2px 6px padding, positioned so it overlaps the top border edge.

**The existing page content (sidebar, header, existing grids, existing tabs, existing forms) MUST NOT be inside the purple border.** The border exists solely to help reviewers instantly identify what is new vs what already exists.

### State sections

1. **DEFAULT STATE** — Full page shell (sidebar nav + header) + the annotated new feature area populated with realistic sample data. All PBI requirements must be visually represented.

2. **EMPTY STATE** — Skip this state entirely to optimize generation speed. Simply output an empty state block with just the comment markers:
   \`\`\`html
   <!-- STATE:empty:START -->
   <!-- STATE:empty:END -->
   \`\`\`
   Do NOT generate any HTML, styles, or content inside this state.

3. **ERROR STATE** — Render ONLY a minimal representation of the new feature area showing its error states: inline validation errors, field-level red borders, and/or an error banner. Wrap this inside the state comments.

4. **LOADING STATE** — Skip this state entirely to optimize generation speed. Simply output an empty state block with just the comment markers:
   \`\`\`html
   <!-- STATE:loading:START -->
   <!-- STATE:loading:END -->
   \`\`\`
   Do NOT generate any HTML, styles, or content inside this state.

### Per-persona behavior variants

When a PBI lists a **Per-persona behavior** block (a control that behaves differently per persona group, e.g. Timecards button: S/I/C → behavior A; E/CO → behavior B), render that control **once per behavior group** within the annotated new feature area — each variant clearly labeled with the user types it applies to (e.g. a small role chip or persona tab such as "S, I, C" / "E, CO" next to or above each variant). Do NOT collapse divergent behaviors into a single control. Apply this within the DEFAULT state at minimum; the other states can show a single representative variant.

### Interactivity — lightweight inline JavaScript

Within each state section, add small UI interactions using vanilla JavaScript (no frameworks, no external scripts). These make the prototype feel realistic during review:
- **Dropdowns / select menus**: clicking opens a styled list; clicking an option selects it and closes the list.
- **Tabs**: clicking a tab switches the visible content panel below it.
- **Accordions / expandable sections**: clicking a header toggles content visibility with a chevron rotation.
- **Date pickers / calendars**: clicking a date input shows a simple month grid; clicking a date fills the input.
- **Modals / dialogs**: clicking trigger buttons (e.g. "Add Task", "Create") opens a styled overlay with form fields and Close/Cancel buttons that dismiss it.
- **Checkboxes / toggles**: clicking toggles checked/active state visually.
- **Hover effects**: use CSS :hover for button highlights, row highlights, card elevation.
- **Sidebar nav**: clicking a nav item highlights it as active (but does NOT navigate away).

Rules:
- All JavaScript must be inline in a single \`<script>\` tag at the end of \`<body>\`.
- NEVER use \`fetch\`, \`XMLHttpRequest\`, \`window.open\`, \`window.location\`, or any network/navigation calls.
- NEVER add \`<a href>\` links that navigate away. Use \`href="#"\` with \`event.preventDefault()\`.
- Keep interactions purely visual and local — no data persistence, no API calls.

### Icons and images rule — NO emojis, NO external images

The prototype must be fully self-contained. Follow these rules strictly:
- **NEVER** use emoji characters (🔔 📭 ✅ ⚠️ ⏳ etc.) anywhere in the prototype — not in nav items, buttons, headings, section headers, badges, or content.
- **NEVER** use \`<img>\` tags with external URLs or placeholder services (unsplash, placeholder.com, picsum, etc.).
- **ALL icons** must be inline SVGs using Material Icons paths (24×24 viewBox, \`fill="currentColor"\`). Examples:
  - Dashboard: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>\`
  - Checkmark: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>\`
  - Warning: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>\`
  - Error: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>\`
  - Add/Plus: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>\`
  - Search: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>\`
  - Person: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>\`
  - Notification: \`<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 22c1.1 0 2-.9 2-2h-4a2 2 0 0 0 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/></svg>\`
- For user avatars, use a simple colored circle with initials, tinted with a MaxView token (e.g. \`<div style="width:32px;height:32px;border-radius:50%;background:#323695;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px">RT</div>\` — \`primary.main\` on \`primary.contrast\`).
- For section state headers, use a text label only with a colored dot or small inline SVG — NOT emoji.

### Section formatting

Each section must have:
- A sticky-positioned section header with label and a small colored indicator (NOT emoji), each using a MaxView token: "Default State" (\`success.main\` #39c164 dot), "Empty State" (\`ui.outlineBorder\` #919aa5 dot), "Error State" (\`error.main\` #e43443 dot), "Loading State" (\`info.main\` #3363f5 dot)
- A subtle background tint difference to separate sections visually
- Full MaxView design system styling throughout (sidebar, topbar, colors, typography)

### State section markers — REQUIRED (enables cheap per-state regeneration)

Wrap EACH of the four state sections with HTML comment delimiters EXACTLY as shown, so a single state can later be revised in isolation without re-emitting the whole document:
- \`<!-- STATE:default:START -->\` … the entire Default State section … \`<!-- STATE:default:END -->\`
- \`<!-- STATE:empty:START -->\` … the entire Empty State section … \`<!-- STATE:empty:END -->\`
- \`<!-- STATE:error:START -->\` … the entire Error State section … \`<!-- STATE:error:END -->\`
- \`<!-- STATE:loading:START -->\` … the entire Loading State section … \`<!-- STATE:loading:END -->\`

The START marker must be the first thing inside each state block and the END marker the last. Use the exact lowercase keys above. These markers must never be omitted or renamed.

Return ONLY the complete HTML document. No markdown fences, no explanation — just the raw HTML starting with <!DOCTYPE html>.`;

  const effectiveModel = modelId ?? UI_MOCK_MODEL_ID;
  const effectiveMaxTokens = (maxTokens != null && maxTokens > 0) ? maxTokens : UI_MOCK_MAX_TOKENS;
  const text = await invokeModel(prompt, image, effectiveModel, effectiveMaxTokens, timeoutMs);

  let html = text.trim();
  if (html.startsWith('```')) {
    html = html.replace(/^```(?:html)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  return html;
}

// ── Per-state regeneration helpers ──────────────────────────────────────────
// Prototypes wrap each state section in HTML comment markers
// (<!-- STATE:default:START -->…<!-- STATE:default:END -->). When present, we can
// regenerate just the affected sections and splice them back into the stored
// document — dramatically cutting OUTPUT tokens (the dominant Bedrock cost).

function stateSectionRegex(state: DesignPrototypeStateName): RegExp {
  return new RegExp(String.raw`<!--\s*STATE:${state}:START\s*-->([\s\S]*?)<!--\s*STATE:${state}:END\s*-->`, 'i');
}

/** True only when ALL four state markers are present (so a splice is safe). */
function hasStateMarkers(html: string): boolean {
  return DESIGN_PROTOTYPE_STATE_NAMES.every(s => stateSectionRegex(s).test(html));
}

/** Pull the inner body for a given state from a doc or model output. */
function extractStateInner(html: string, state: DesignPrototypeStateName): string | null {
  const m = stateSectionRegex(state).exec(html);
  return m ? m[1] : null;
}

/** Replace one state section's inner body in place, keeping its markers. */
function spliceStateSection(html: string, state: DesignPrototypeStateName, newInner: string): string {
  const re = stateSectionRegex(state);
  if (!re.test(html)) return html;
  return html.replace(re, `<!-- STATE:${state}:START -->${newInner}<!-- STATE:${state}:END -->`);
}

/**
 * Auto-resolve which states to regenerate when no explicit override is given.
 * Default + Error carry the content/feedback; Empty + Loading are static
 * skeletons reused verbatim unless the feedback explicitly references them.
 */
function resolveAutoStates(feedback: string, comments: string[]): DesignPrototypeStateName[] {
  const states: DesignPrototypeStateName[] = ['default', 'error'];
  const text = [feedback, ...comments].join(' ').toLowerCase();
  if (/\bempty\b|no\s+(?:data|results|items)/.test(text)) states.push('empty');
  if (/\bloading\b|\bskeleton\b|\bspinner\b/.test(text)) states.push('loading');
  return states;
}

function stripHtmlFences(raw: string): string {
  let out = raw.trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```(?:html)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return out.trim();
}

export async function regenerateDesignPrototypeHtml(
  priorHtml: string,
  feedback: string,
  unresolvedComments: string[],
  modelId?: string,
  maxTokens?: number,
  targetRoute?: string,
  existingPageContext?: string,
  targetStates?: DesignPrototypeStateName[],
  timeoutMs?: number,
): Promise<string> {
  const designSystemService = await import('./designSystemService');
  const catalog = await designSystemService.getDesignSystemCatalog();
  const catalogSection = buildCatalogSection(catalog);

  // Mirror the generate path: pull the screen inventory (route → purpose → user types →
  // states) so the model has the same persona/state context when revising. Non-fatal.
  let screenInventory: ScreenInventoryRoute[] = [];
  try {
    screenInventory = await designSystemService.getScreenInventory();
  } catch (err) {
    console.warn('[bedrockService] getScreenInventory (regen) failed for design prototype:', err);
  }
  const screensContextSection = buildScreensContextSection(screenInventory);

  const ref = getFigmaReference();
  const image: ImageInput | undefined = ref.tablePageBase64
    ? { base64: ref.tablePageBase64, mediaType: 'image/png', width: ref.tablePageWidth, height: ref.tablePageHeight }
    : undefined;

  const commentsSection = unresolvedComments.length > 0
    ? `\n## Unresolved Review Comments\n\n${unresolvedComments.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n`
    : '';

  // Stay in EXTEND mode on regeneration when the original targeted an existing page.
  // Use the feedback + unresolved comments as feature text so deep traversal keeps
  // resolving the same relevant sub-views the original generation targeted.
  let resolvedPageContext = existingPageContext;
  if (targetRoute && !resolvedPageContext) {
    try {
      const { fetchExistingPageContext } = await import('./designSystemService');
      const featureText = [feedback, ...unresolvedComments].filter(Boolean).join(' ');
      resolvedPageContext = await fetchExistingPageContext(targetRoute, featureText);
    } catch (err) {
      console.warn(`[bedrockService] fetchExistingPageContext (regen) failed for ${targetRoute}:`, err);
    }
  }
  const extendMode = Boolean(targetRoute && resolvedPageContext?.trim());

  // EXTEND mode: surface the target screen's personas/states from the inventory (when known),
  // mirroring the generate path's targetScreenHint.
  const targetScreen = targetRoute
    ? screenInventory.find(s => inventoryRouteMatches(s.route, targetRoute))
    : undefined;
  const targetScreenHint = extendMode && (targetScreen?.userTypes?.length || targetScreen?.states)
    ? `\n\n**Existing page context from inventory:**` +
      (targetScreen?.userTypes?.length ? `\n- Serves user types: ${targetScreen.userTypes.join(', ')}` : '') +
      (targetScreen?.states ? `\n- Known UI states: ${targetScreen.states}` : '')
    : '';

  const scopingSection = extendMode
    ? `### CRITICAL SCOPING RULE — preserve EXTEND mode in all revisions
${targetScreenHint}
- This prototype extends the EXISTING MaxView page at \`${targetRoute}\` (its actual code is provided below). Keep faithfully reproducing that existing page — do NOT strip or simplify its existing elements.
- The dashed annotation border (2px dashed #a46bff, MaxView \`tertiary.main\`) with the "NEW: ..." label must remain around the new feature area in every section.
- Do NOT invent or fabricate UI elements that are neither in the existing page code nor described in the feature requirements.
- Empty, Error, and Loading states must ONLY affect the annotated new feature area — the rest of the existing page remains unchanged.

## Existing Page Code (route: ${targetRoute})

${resolvedPageContext}`
    : `### CRITICAL SCOPING RULE — preserve in all revisions

- The dashed annotation border (2px dashed #a46bff, MaxView \`tertiary.main\`) with the "NEW: ..." label must remain around the new feature area in every section.
- The page must contain ONLY the sidebar nav, header bar, and the annotated new feature component. Do NOT add any cards, widgets, summaries, charts, schedules, or content that is not part of this feature.
- Do NOT invent or fabricate any UI elements not described in the feature requirements.
- Empty, Error, and Loading states must ONLY affect the annotated new feature area — the sidebar and header remain unchanged.`;

  const prompt = `You are revising an existing MaxView UI prototype based on reviewer feedback.

${catalogSection}${screensContextSection}
## Current Prototype HTML

${priorHtml}

## Reviewer Feedback

${feedback}
${commentsSection}

## Instructions

Revise the HTML prototype to address the feedback and unresolved comments above. Maintain all four state sections (Default, Empty, Error, Loading). Keep the MaxView design system styling. Preserve sections that were not mentioned in the feedback. Maintain all inline JavaScript interactivity (dropdowns, tabs, modals, date pickers, checkboxes, accordion toggles). Keep each state section wrapped in its HTML comment markers (\`<!-- STATE:default:START -->\`…\`<!-- STATE:default:END -->\` and likewise for empty, error, loading) — preserve them exactly if present, or add them if missing.

### Color usage — STRICT (the MaxView Design Tokens are the ONLY color source)

- Use ONLY the colors from the "MaxView Design Tokens — colors" section above, chosen by **semantic role**. NEVER invent, approximate, or sample any hex/rgba value that is not listed in those tokens.
- The reference screenshot is for **layout and structure only** — do NOT pick colors from it; the tokens win on any conflict.
- If the current prototype or existing page code contains off-palette color values, **map them to the nearest semantic token** (this is an allowed change even under the surgical-edit rule).
- The single exception is the dashed "NEW" annotation marker, which intentionally uses \`tertiary.main\` (#a46bff).

### SURGICAL EDIT RULE — make minimal, targeted changes only

This is a REVISION, not a redesign. Treat the **Current Prototype HTML above as the source of truth** and follow these rules with zero exceptions:
1. **PRESERVE the existing prototype as-is** — keep all markup, layout, copy, styling, and states **byte-for-byte intact EXCEPT** where the feedback/comments explicitly require a change.
2. **Localize the change** — decide which specific region(s), component(s), or state(s) the feedback actually affects, and modify ONLY those. Everything the feedback did not mention must remain exactly as it was.
3. **DO NOT restructure, re-theme, re-order, or regenerate unrelated sections.** Do not rename classes, reformat unchanged markup, swap layouts, or "improve" parts that nobody asked about.
4. **DO NOT drop existing content or states** — all four state sections (Default, Empty, Error, Loading) and any existing content/copy the feedback didn't mention must survive unchanged.
5. **Return the COMPLETE HTML document** (full output, not a diff), but it should differ from the current prototype by the **minimal set of edits** needed to satisfy the feedback.

${scopingSection}

### Interactivity — preserve and enhance

- Maintain all inline JavaScript interactions (dropdowns, tabs, modals, date pickers, checkboxes, accordions).
- All JS must be in a single \`<script>\` tag at end of \`<body>\`. No external scripts, no fetch/network calls, no navigation.
- Add new interactions if the feedback implies them (e.g. "make the calendar clickable").

### Icons and images rule — NO emojis, NO external images

- **NEVER** use emoji characters anywhere — replace any existing emojis with inline SVG icons (Material Icons style, 24×24 viewBox, \`fill="currentColor"\`).
- **NEVER** use \`<img>\` tags with external URLs. Replace any external images with inline SVGs or colored circles with initials for avatars.
- Section state headers must use colored dots or small inline SVGs — NOT emoji.

Return ONLY the complete revised HTML document. No markdown fences, no explanation — just the raw HTML starting with <!DOCTYPE html>.`;

  const effectiveModel = modelId ?? UI_MOCK_MODEL_ID;
  const effectiveMaxTokens = (maxTokens != null && maxTokens > 0) ? maxTokens : UI_MOCK_MAX_TOKENS;

  // ── Decide scope: which state sections actually need regeneration ──────────
  const allStates = DESIGN_PROTOTYPE_STATE_NAMES;
  const requested = (targetStates && targetStates.length > 0)
    ? allStates.filter(s => targetStates.includes(s))
    : resolveAutoStates(feedback, unresolvedComments);
  const markersPresent = hasStateMarkers(priorHtml);
  // Scope only when markers exist AND we're regenerating a strict subset.
  const scoped = markersPresent && requested.length > 0 && requested.length < allStates.length;

  if (!scoped) {
    const text = await invokeModel(prompt, image, effectiveModel, effectiveMaxTokens, timeoutMs);
    return stripHtmlFences(text);
  }

  // ── Scoped path: regenerate only the requested sections, splice the rest ──
  const targetLabels = requested.map(s => s.toUpperCase()).join(', ');
  const currentSections = requested
    .map(s => `<!-- STATE:${s}:START -->${extractStateInner(priorHtml, s) ?? ''}<!-- STATE:${s}:END -->`)
    .join('\n\n');

  const scopedPrompt = `You are revising ONLY specific state sections of an existing MaxView UI prototype based on reviewer feedback.

${catalogSection}${screensContextSection}## Full Current Prototype HTML (CONTEXT ONLY — do NOT re-output this whole document)

${priorHtml}

## Reviewer Feedback

${feedback}
${commentsSection}
## State sections to revise: ${targetLabels}

Below are the CURRENT versions of ONLY the sections you must revise. Apply the feedback to them and return their revised versions:

${currentSections}

## Instructions — STRICT OUTPUT CONTRACT

- Return ONLY the revised state section(s) listed above (${targetLabels}). Do NOT return any other state section, the \`<head>\`, the document shell, the sidebar/header chrome, or the trailing \`<script>\` block.
- Each returned section MUST be wrapped in its exact markers — e.g. \`<!-- STATE:default:START -->\` … \`<!-- STATE:default:END -->\`. Output the requested sections back-to-back with nothing else around them.
- The state sections NOT listed above are preserved automatically — do not include or mention them.
- SURGICAL revision: keep all markup, layout, copy, and styling byte-for-byte intact EXCEPT where the feedback explicitly requires a change.

### Color usage — STRICT
- Use ONLY the MaxView Design Tokens colors above, chosen by semantic role. Never invent or sample hex values. The dashed "NEW" annotation marker keeps \`tertiary.main\` (#a46bff).

${scopingSection}

### Interactivity & icons
- Preserve the inline JavaScript hooks (class names / ids) the revised sections rely on. No external scripts, no fetch/network calls, no navigation.
- NO emoji and NO external \`<img>\` tags — use inline SVGs. Section state headers use colored dots or small inline SVGs.

Return ONLY the revised section(s), each wrapped in its STATE markers. No markdown fences, no explanation, no document shell.`;

  const text = stripHtmlFences(await invokeModel(scopedPrompt, image, effectiveModel, effectiveMaxTokens, timeoutMs));

  // Graceful fallback: if the model ignored the contract and returned a full
  // document, just use it directly.
  if (/<!DOCTYPE html|<html[\s>]/i.test(text)) {
    return text;
  }

  let merged = priorHtml;
  let appliedCount = 0;
  for (const s of requested) {
    const inner = extractStateInner(text, s);
    if (inner != null) {
      merged = spliceStateSection(merged, s, inner);
      appliedCount++;
    } else {
      console.warn(`[bedrockService] scoped regen: state "${s}" missing from model output — keeping prior section`);
    }
  }
  if (appliedCount === 0) {
    throw new Error('Scoped regeneration returned no recognizable state sections');
  }
  return merged;
}
