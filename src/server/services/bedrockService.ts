import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import https from 'https';

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
});

const MODEL_ID =
  process.env.BEDROCK_MODEL_ID ?? 'anthropic.claude-3-5-haiku-20241022-v1:0';

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

export interface GeneratedFeatureData {
  title: string;
  description: string;
  priority: string;
  confidence: string;
  tags: string[];
  clarificationNeeded?: string;
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

  const jsonMatch =
    text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error('Could not parse structured PBI from AI response');
  }

  const parsed = JSON.parse(jsonMatch[1]) as GeneratedPBIData;

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

  const jsonMatch =
    text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error('Could not parse structured Feature from AI response');
  }

  const parsed = JSON.parse(jsonMatch[1]) as GeneratedFeatureWithPBIs;

  const feature: GeneratedFeatureData = {
    title: parsed.feature?.title ?? '',
    description: parsed.feature?.description ?? '',
    priority: parsed.feature?.priority ?? 'Medium',
    confidence: parsed.feature?.confidence ?? 'Medium',
    tags: Array.isArray(parsed.feature?.tags) ? parsed.feature.tags : [],
    clarificationNeeded: parsed.feature?.clarificationNeeded || undefined,
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
6. **clarificationNeeded** — one sentence identifying the most important open question, or omit if none.

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
    "clarificationNeeded": "..."
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
  clarificationQuestion: string;
  userAnswer: string;
  parentType?: string;
  parentTitle?: string;
  /** For Epic: existing Features. For Feature: existing PBIs. For PBI: sibling PBIs. */
  existingChildren?: Array<{ id: string; title: string; workItemType: string }>;
}

export interface ClarificationUpdatedFields {
  description?: string;
  clarificationNeeded?: string;
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

  const jsonMatch =
    text.match(/```json\s*([\s\S]*?)\s*```/) ?? text.match(/(\{[\s\S]*\})/);

  if (!jsonMatch) {
    throw new Error('Could not parse structured clarification resolution from AI response');
  }

  const parsed = JSON.parse(jsonMatch[1]) as ResolveClarificationResult;

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

  return `You are a senior product owner resolving a clarification on a backlog work item.

${skillSection}## Work Item Being Reviewed

**Type:** ${input.workItemType}
${parentSection}**Title:** "${input.title}"
${input.description ? `**Current Description:**\n${input.description}\n` : ''}${childrenSection}
## Clarification Question That Was Flagged

"${input.clarificationQuestion}"

## User's Answer

"${input.userAnswer}"

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
- clarificationNeeded must always appear in updatedFields (use "" to clear it, or a revised question if still partially unclear).
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
