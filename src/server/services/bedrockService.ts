import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import https from 'https';
import { getFigmaReference } from './figmaReferenceService';
import type { DesignSystemCatalog } from './designSystemService';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
});

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
 * 16K covers a typical mock comfortably; raise via env var if you observe
 * "model refused" / truncated-JSON errors with a particularly large mock.
 */
const UI_MOCK_MAX_TOKENS = (() => {
  const raw = process.env.BEDROCK_UI_MOCK_MAX_TOKENS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16000;
})();

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

export interface GenerateUiMockInput {
  featureTitle: string;
  featureDescription?: string;
  featureTags?: string[];
  acceptanceCriteria?: string[];
  epicTitle?: string;
  catalog: DesignSystemCatalog;
  /** When generating a PBI-scoped view, pass the feature-level mock context so the AI
   *  stays within the same page/tab structure rather than making a fresh routing decision. */
  featureContext?: FeatureMockContext;
  /** Free-form context provided by the BA/UX designer at generation time —
   *  e.g. tone, user persona, specific constraints, or layout preferences.
   *  Applied to every mock in a "Generate All" batch for consistency. */
  additionalContext?: string;
  /** Full HTML of the feature-overview mock (when generating a PBI-scoped view as part
   *  of a "Generate All" batch). The inner content is extracted and shown to the AI so
   *  it can mirror the same layout patterns, CSS classes, and component choices. */
  featureOverviewHtml?: string;
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
  { label: 'Dashboard',         route: '/dashboard',         icon: 'grid_view' },
  { label: 'Document Manager',  route: '/document-manager',  icon: 'folder_open' },
  { label: 'Assignments',       route: '/assignments',        icon: 'assignment' },
  { label: 'Shift Scheduler',   route: '/shift-scheduler',   icon: 'calendar_month' },
  { label: 'Timecards',         route: '/timecards',         icon: 'timer' },
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

  const routeList = catalog.routes.length > 0
    ? catalog.routes.map(r => `- \`${r.path}\` — ${r.title}`).join('\n')
    : DEFAULT_NAV_ITEMS.map(n => `- \`${n.route}\` — ${n.label}`).join('\n');

  parts.push(`### Existing application pages (MaxView sidebar nav)\n\n${routeList}`);

  if (catalog.componentNames.length > 0) {
    const names = catalog.componentNames.slice(0, 40);
    parts.push('### Existing components in the codebase\n\n' + names.map(n => `- \`${n}\``).join('\n'));
  }

  return `## MaxView Application Context\n\n${parts.join('\n\n')}\n\n---\n\n`;
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

  /* ── PBI context block — locks page structure when generating a PBI-scoped view ── */
  const ctx = input.featureContext;
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

${skillSection}${catalogSection}${featureContextSection}## Feature to analyse

**Feature:** "${input.featureTitle}"
${input.epicTitle ? `**Epic:** "${input.epicTitle}"\n` : ''}${input.featureDescription ? `**Description:**\n${input.featureDescription}\n` : ''}${acSection}${tagsSection}${additionalContextSection}${featureOverviewSection}

## Your task

### Step 1 — Make the UI decision

${ctx
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
  maxTokens: number = 4096
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

  const response = await client.send(command);
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
  catalog: DesignSystemCatalog
): UiMockResult {
  const parsed = JSON.parse(extractJson(text, 'UiMock')) as Record<string, unknown>;

  const validDecisions: UiMockDecision[] = ['new-page', 'update-page', 'no-ui'];
  const decision: UiMockDecision = validDecisions.includes(parsed.decision as UiMockDecision)
    ? (parsed.decision as UiMockDecision)
    : 'no-ui';

  const targetPageRoute = typeof parsed.targetPageRoute === 'string' ? parsed.targetPageRoute : undefined;
  const targetPageTitle = typeof parsed.targetPageTitle === 'string' ? parsed.targetPageTitle : undefined;
  const targetPageSubTabs = Array.isArray(parsed.targetPageSubTabs)
    ? (parsed.targetPageSubTabs as string[])
    : [];
  const targetSubTabActive = typeof parsed.targetSubTabActive === 'string' ? parsed.targetSubTabActive : undefined;
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
  return parseUiMockResult(text, input.catalog);
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
  return parseUiMockResult(text, input.catalog);
}
