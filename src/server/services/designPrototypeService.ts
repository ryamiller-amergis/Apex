import { eq, and, asc, desc, inArray, lt, type SQL } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designPrototypes, designPrototypeComments, designPlans, designDocs, prds } from '../db/schema';
import type { DesignPlanFeature } from '../../shared/types/designPlan';
import type { DesignPrototypeInput } from './bedrockService';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import { isAdminUser } from '../utils/rbacHelpers';
import { isAssignedApprover } from './documentApprovalService';
import { notifyAiCompletion } from './aiCompletionNotifier';
import type {
  DesignPrototypeSummary,
  DesignPrototype,
  DesignPrototypeComment,
  DesignPrototypeHistoryEntry,
  DesignPrototypeStateName,
  PbiRequirement,
} from '../../shared/types/designPrototype';

type AcceptanceCriterionEntry =
  | string
  | { given?: string; when?: string; then?: string; value?: string; text?: string; scenario?: string };

interface BacklogItem {
  id?: string;
  type?: string;
  workItemType?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string | AcceptanceCriterionEntry[];
  acceptance_criteria?: string | AcceptanceCriterionEntry[];
  definitionOfDone?: string[];
  userStory?: {
    persona?: string;
    iWant?: string;
    soThat?: string;
  };
  /** User-type slugs (e.g. S/I/C/E/CO) this item applies to. */
  userTypes?: string[];
  /** Same control, different behavior per persona group. */
  personaBehaviors?: Array<{ userTypes: string[]; behavior: string }>;
}

export interface BacklogFeature {
  title: string;
  description?: string;
  items?: BacklogItem[];
  pbis?: BacklogItem[];
  /** Optional route of an existing MaxView page this feature extends (enables EXTEND mode). */
  route?: string;
}

interface BacklogJson {
  epics?: Array<{
    features?: BacklogFeature[];
  }>;
  features?: BacklogFeature[];
}

export function extractFeatures(backlogJson: unknown): BacklogFeature[] {
  const bj = backlogJson as BacklogJson | null;
  if (!bj) return [];

  const features: BacklogFeature[] = [];

  if (bj.features) {
    features.push(...bj.features);
  }

  if (bj.epics) {
    for (const epic of bj.epics) {
      if (epic.features) {
        features.push(...epic.features);
      }
    }
  }

  return features;
}

/** True for PBI child items; excludes TBIs and other non-PBI work item types. */
function isPbiBacklogItem(item: BacklogItem): boolean {
  if (item.type === 'TBI' || item.workItemType === 'TBI') return false;
  if (item.type === 'PBI' || item.workItemType === 'PBI' || item.workItemType === 'Product Backlog Item') {
    return true;
  }
  // Untyped legacy entries under feature.items are treated as PBIs (TBIs are always typed).
  if (item.type && item.type !== 'PBI') return false;
  return true;
}

/**
 * Normalise a single acceptance-criterion entry to a readable string. Backlog AC can be a
 * plain string, a Gherkin object ({ given, when, then }), or a form-array leak ({ value }).
 */
function formatAcceptanceCriterion(entry: AcceptanceCriterionEntry): string {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';

  if (typeof entry.value === 'string' && entry.value.trim()) return entry.value.trim();
  if (typeof entry.text === 'string' && entry.text.trim()) return entry.text.trim();

  const parts: string[] = [];
  if (entry.given?.trim()) parts.push(`Given ${entry.given.trim()}`);
  if (entry.when?.trim()) parts.push(`When ${entry.when.trim()}`);
  if (entry.then?.trim()) parts.push(`Then ${entry.then.trim()}`);
  return parts.join(', ');
}

function formatAcceptanceCriteriaList(lines: string[]): string | undefined {
  const filtered = lines.map(l => l.trim()).filter(Boolean);
  if (filtered.length === 0) return undefined;
  return filtered.length === 1 ? filtered[0] : filtered.map(l => `- ${l}`).join('\n');
}

function extractAcceptanceCriteria(item: BacklogItem): string | undefined {
  const raw = item.acceptanceCriteria ?? item.acceptance_criteria;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }

  if (Array.isArray(raw) && raw.length > 0) {
    return formatAcceptanceCriteriaList(raw.map(formatAcceptanceCriterion));
  }

  if (item.definitionOfDone?.length) {
    return formatAcceptanceCriteriaList(item.definitionOfDone);
  }

  return undefined;
}

function mapBacklogItemToPbiRequirement(item: BacklogItem): PbiRequirement {
  let description = item.description?.trim();
  if (!description && item.userStory) {
    const us = item.userStory;
    description = `As a ${us.persona ?? 'user'}, I want to ${us.iWant ?? '...'} so that ${us.soThat ?? '...'}`;
  }

  return {
    title: item.title,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(item),
    userTypes: item.userTypes,
    personaBehaviors: item.personaBehaviors,
  };
}

/** Extract only PBI-type child items for a feature (excludes TBIs). */
export function extractPbiRequirements(feature: BacklogFeature): PbiRequirement[] {
  const items = (feature.items ?? feature.pbis ?? []).filter(isPbiBacklogItem);
  return items.map(mapBacklogItemToPbiRequirement);
}

/**
 * Scope PBI requirements to those associated with a feature. When a design plan exists,
 * its per-feature pbiContributions list is the authoritative allowlist (matched by title).
 */
export function scopePbiRequirementsForFeature(
  feature: BacklogFeature,
  planFeature?: DesignPlanFeature,
): PbiRequirement[] {
  const requirements = extractPbiRequirements(feature);
  if (!planFeature?.pbiContributions?.length) return requirements;

  const byTitle = new Map(
    requirements.map(r => [r.title.trim().toLowerCase(), r]),
  );

  return planFeature.pbiContributions.map(contrib => {
    const key = contrib.pbiTitle.trim().toLowerCase();
    const existing = byTitle.get(key);
    if (existing) return existing;
    return {
      title: contrib.pbiTitle,
      description: contrib.contribution,
    };
  });
}

function resolveUserName(_userId: string): string | undefined {
  return undefined;
}

function toSummary(row: typeof designPrototypes.$inferSelect): DesignPrototypeSummary {
  return {
    id: row.id,
    prdId: row.prdId,
    featureName: row.featureName,
    featureIndex: row.featureIndex,
    authorId: row.authorId,
    authorName: resolveUserName(row.authorId),
    status: row.status as DesignPrototypeSummary['status'],
    mockVersion: row.mockVersion,
    reviewerId: row.reviewerId ?? undefined,
    reviewerName: row.reviewerId ? resolveUserName(row.reviewerId) : undefined,
    reviewComment: row.reviewComment ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    generationError: row.generationError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Generation ──────────────────────────────────────────────────────────────

/**
 * How many prototype HTML generations may hit Bedrock at once. Firing every
 * feature in parallel throttles large models (Opus/Sonnet) hard — concurrent
 * calls pile into ThrottlingException, back off, and blow past the per-call
 * timeout. A small cap keeps each call un-throttled so it finishes in normal
 * time. Override via DESIGN_PROTOTYPE_CONCURRENCY (default 2).
 */
const PROTOTYPE_GENERATION_CONCURRENCY = (() => {
  const raw = process.env.DESIGN_PROTOTYPE_CONCURRENCY;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
})();

/**
 * Run `task` over each item with at most `limit` running concurrently.
 * Resolves when all have settled. Tasks are expected to handle their own errors
 * (each generation persists its own failure state), so rejections are logged.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

type PrototypeSkipReason = 'no-ui' | 'no-pbi';

/**
 * Decide whether a feature actually needs an LLM-generated HTML prototype.
 * Features the design plan marked `no-ui` (backend, infra, config, or scheduled
 * jobs) or that have no linked PBIs have nothing to render — generating a mock
 * for them only burns Bedrock output tokens for a "No UI" placeholder. Returning
 * a reason here lets the caller skip the model call entirely.
 */
function resolvePrototypeSkipReason(
  feature: BacklogFeature,
  planFeature?: DesignPlanFeature,
): PrototypeSkipReason | null {
  if (planFeature?.decision === 'no-ui') return 'no-ui';
  if (extractPbiRequirements(feature).length === 0) return 'no-pbi';
  return null;
}

/**
 * Deterministic, self-contained placeholder rendered for features that need no UI
 * prototype. Built locally (zero model tokens) and shown in the review iframe so
 * the feature stays visible and the reviewer understands why no mock exists.
 */
function buildSkippedPrototypeHtml(
  featureName: string,
  reason: PrototypeSkipReason,
  planFeature?: DesignPlanFeature,
): string {
  const heading = reason === 'no-ui' ? 'No User Interface Required' : 'Nothing to Prototype';
  const chip = reason === 'no-ui' ? 'Backend / server-side only' : 'No linked PBIs';
  const explanation = reason === 'no-ui'
    ? 'The design plan classified this feature as backend, infrastructure, configuration, or a scheduled job with no user-facing surface. No prototype was generated, so no AI tokens were spent.'
    : 'This feature has no linked PBIs, so there are no requirements to render. No prototype was generated, so no AI tokens were spent.';

  const context = planFeature?.designBrief?.trim() || planFeature?.rationale?.trim();
  const contextBlock = context
    ? `<div class="ctx"><div class="ctx-label">From the design plan</div><div class="ctx-body">${escapeHtml(context)}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(featureName)} — No UI</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: #f4f5f7; color: #1f2430; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 40px; }
  .card { background: #ffffff; border: 1px solid #e3e6ea; border-radius: 12px; max-width: 560px; width: 100%; padding: 40px; text-align: center; box-shadow: 0 1px 3px rgba(16,24,40,0.06); }
  .icon { width: 56px; height: 56px; border-radius: 50%; background: #eef0f4; color: #5b6472; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  .feature { font-size: 13px; color: #6b7280; margin: 0 0 16px; }
  .chip { display: inline-block; font-size: 12px; font-weight: 600; color: #5b6472; background: #eef0f4; border-radius: 999px; padding: 4px 12px; margin-bottom: 16px; }
  p.explain { font-size: 14px; line-height: 1.5; color: #4a5160; margin: 0; }
  .ctx { text-align: left; margin-top: 24px; padding: 16px; background: #f8f9fb; border: 1px solid #e3e6ea; border-radius: 8px; }
  .ctx-label { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #8a93a2; margin-bottom: 6px; }
  .ctx-body { font-size: 13px; line-height: 1.5; color: #4a5160; white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/></svg>
    </div>
    <h1>${escapeHtml(heading)}</h1>
    <div class="feature">${escapeHtml(featureName)}</div>
    <div class="chip">${escapeHtml(chip)}</div>
    <p class="explain">${escapeHtml(explanation)}</p>
    ${contextBlock}
  </div>
</body>
</html>`;
}

export async function generatePrototypesForPrd(prdId: string): Promise<string[]> {
  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prd) throw new Error(`PRD ${prdId} not found`);

  const { getSkillConfig } = await import('./projectSettingsService');
  const skillConfig = await getSkillConfig(prd.project);
  const prototypeModel = skillConfig?.designPrototypeBedrockModelId ?? undefined;
  const prototypeMaxTokens = skillConfig?.designPrototypeBedrockMaxTokens ?? undefined;
  const prototypeTimeoutMs = skillConfig?.designPrototypeBedrockTimeoutMs ?? undefined;

  const features = extractFeatures(prd.backlogJson);
  if (features.length === 0) {
    console.warn(`[designPrototypeService] No features found in PRD ${prdId} backlogJson`);
    return [];
  }

  // Load the reviewed/edited design plan (when present) so its decisions steer generation.
  const planRow = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, prdId) });
  const planFeatures = planRow?.features ?? [];

  // Idempotent (re)generation: skip features that already have a prototype row so
  // re-running only fills in the missing ones (e.g. after a delete) and never
  // creates duplicates. The first generation has no existing rows → generates all.
  const existingRows = await db
    .select({ featureIndex: designPrototypes.featureIndex })
    .from(designPrototypes)
    .where(eq(designPrototypes.prdId, prdId));
  const existingIndices = new Set(existingRows.map(r => r.featureIndex));

  const ids: string[] = [];
  const pending: Array<{ prototypeId: string; feature: BacklogFeature; planFeature?: DesignPlanFeature }> = [];

  for (let i = 0; i < features.length; i++) {
    if (existingIndices.has(i)) continue;
    const feature = features[i];
    const planFeature = planFeatures.find(f => f.featureIndex === i);
    const skipReason = resolvePrototypeSkipReason(feature, planFeature);

    if (skipReason) {
      // No UI / no PBIs → skip the expensive Bedrock call. Store a deterministic
      // placeholder and auto-approve so the feature stays visible without blocking
      // the reviewer or burning tokens.
      const now = new Date().toISOString();
      const html = buildSkippedPrototypeHtml(feature.title, skipReason, planFeature);
      const historyEntry: DesignPrototypeHistoryEntry = { version: 1, html, createdAt: now };
      const [row] = await db
        .insert(designPrototypes)
        .values({
          prdId,
          featureName: feature.title,
          featureIndex: i,
          authorId: prd.authorId,
          status: 'approved',
          mockHtml: html,
          mockVersion: 1,
          history: [historyEntry],
          reviewComment: skipReason === 'no-ui'
            ? 'Auto-approved: backend-only feature with no user-facing UI.'
            : 'Auto-approved: feature has no linked PBIs to prototype.',
          reviewedAt: now,
          updatedAt: now,
        })
        .returning({ id: designPrototypes.id });
      ids.push(row.id);
      console.log(
        `[designPrototypeService] Skipped generation for feature "${feature.title}" (${skipReason}) — auto-approved, no tokens spent`,
      );
      continue;
    }

    const [row] = await db
      .insert(designPrototypes)
      .values({
        prdId,
        featureName: feature.title,
        featureIndex: i,
        authorId: prd.authorId,
        status: 'generating',
      })
      .returning({ id: designPrototypes.id });
    ids.push(row.id);
    pending.push({ prototypeId: row.id, feature, planFeature });
  }

  // Generate with bounded concurrency so we don't fire every feature at Bedrock
  // at once (which throttles large models and causes timeouts). Runs in the
  // background — the route returns immediately and the UI polls per-prototype.
  if (pending.length > 0) {
    runWithConcurrency(pending, PROTOTYPE_GENERATION_CONCURRENCY, async ({ prototypeId, feature, planFeature }) =>
      generateSinglePrototype(prototypeId, feature, prototypeModel, prototypeMaxTokens, planFeature, prototypeTimeoutMs).catch(err => {
        console.error(`[designPrototypeService] Background generation failed for ${prototypeId}:`, err);
      }),
    )
      .then(() => checkAllApprovedAndProceed(prdId))
      .catch(err => {
        console.error(`[designPrototypeService] Prototype generation batch failed for PRD ${prdId}:`, err);
      });
  }

  // Reviewer assignment + notification now happens at design-plan generation
  // (see designPlanService.generateDesignPlan); the plan is the entry point users see first.

  // When every feature was skipped/auto-approved there are no UI prototypes whose
  // approval would trigger the downstream pipeline, so kick it off here. (When some
  // are still generating this is a safe no-op; the batch above re-checks on finish.)
  await checkAllApprovedAndProceed(prdId).catch(err => {
    console.error(`[designPrototypeService] checkAllApprovedAndProceed failed for PRD ${prdId}:`, err);
  });

  return ids;
}

function planFeatureToInput(planFeature?: DesignPlanFeature): DesignPrototypeInput['plan'] | undefined {
  if (!planFeature) return undefined;
  return {
    designBrief: planFeature.designBrief,
    decision: planFeature.decision,
    layoutPattern: planFeature.layoutPattern,
    targetPageTitle: planFeature.targetPageTitle,
    primaryComponents: planFeature.primaryComponents,
    states: planFeature.states,
    pbiContributions: planFeature.pbiContributions,
    rationale: planFeature.rationale,
    notes: planFeature.notes,
  };
}

async function generateSinglePrototype(prototypeId: string, feature: BacklogFeature, modelId?: string, maxTokens?: number, planFeature?: DesignPlanFeature, timeoutMs?: number): Promise<void> {
  try {
    const { generateDesignPrototypeHtml } = await import('./bedrockService');

    const pbis = extractPbiRequirements(feature);
    // The reviewed plan is authoritative: prefer its route decision over the raw backlog route.
    const planRoute = planFeature?.decision === 'update-page' ? planFeature.targetRoute?.trim() : undefined;
    const targetRoute = planRoute || feature.route?.trim() || undefined;

    let pageScreenshot: { base64: string; mediaType: string } | undefined;
    if (targetRoute) {
      try {
        const { getScreenshotByRoute } = await import('./pageScreenshotService');
        const ss = await getScreenshotByRoute(targetRoute);
        if (ss) pageScreenshot = { base64: ss.imageBase64, mediaType: ss.mediaType };
      } catch (err) {
        console.warn('[designPrototypeService] Page screenshot lookup failed:', err);
      }
    }

    const rawHtml = await generateDesignPrototypeHtml({
      featureName: feature.title,
      featureDescription: feature.description,
      pbis,
      targetRoute,
      pageScreenshot,
      plan: planFeatureToInput(planFeature),
    }, modelId, maxTokens, timeoutMs);

    const html = sanitizeMockHtml(rawHtml);

    const hasAnnotation = /#a46bff/.test(html) && /NEW:/i.test(html);
    const hasFeatureMarkers = /<!--\s*NEW_FEATURE:START\s*-->/.test(html)
      && /<!--\s*NEW_FEATURE:END\s*-->/.test(html);
    if (!hasAnnotation || !hasFeatureMarkers) {
      const missing: string[] = [];
      if (!hasAnnotation) missing.push('purple annotation border');
      if (!hasFeatureMarkers) missing.push('NEW_FEATURE comment markers');
      console.warn(
        `[designPrototypeService] Prototype for "${feature.title}" is missing: ${missing.join(', ')}. ` +
        'Reviewer may not be able to distinguish new vs existing content.',
      );
    }

    const now = new Date().toISOString();
    const historyEntry: DesignPrototypeHistoryEntry = {
      version: 1,
      html,
      createdAt: now,
    };

    await db
      .update(designPrototypes)
      .set({
        mockHtml: html,
        mockVersion: 1,
        history: [historyEntry],
        status: 'pending_review',
        generationError: null,
        updatedAt: now,
      })
      .where(eq(designPrototypes.id, prototypeId));

    notifyAiCompletion('design_prototype_generated', prototypeId, { title: feature.title }).catch(err =>
      console.error(`[designPrototype] AI notification failed (id=${prototypeId}):`, err),
    );
  } catch (err: any) {
    console.error(`[designPrototypeService] Generation error for ${prototypeId}:`, err);
    await db
      .update(designPrototypes)
      .set({
        status: 'generation_failed',
        generationError: err.message ?? 'Unknown error',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(designPrototypes.id, prototypeId));
  }
}

// ── Regeneration ────────────────────────────────────────────────────────────

export async function regeneratePrototype(
  prototypeId: string,
  feedback: string,
  targetStates?: DesignPrototypeStateName[],
): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) throw new Error(`Prototype ${prototypeId} not found`);
  if (!proto.mockHtml) throw new Error('No existing HTML to regenerate from');

  await db
    .update(designPrototypes)
    .set({ status: 'regenerating', updatedAt: new Date().toISOString() })
    .where(eq(designPrototypes.id, prototypeId));

  try {
    const { regenerateDesignPrototypeHtml } = await import('./bedrockService');

    const prd = await db.query.prds.findFirst({ where: eq(prds.id, proto.prdId) });
    // Re-resolve the feature's target route so regenerations stay in EXTEND mode.
    const feature = prd ? extractFeatures(prd.backlogJson)[proto.featureIndex] : undefined;
    const targetRoute = feature?.route?.trim() || undefined;
    const { getSkillConfig } = await import('./projectSettingsService');
    const skillConfig = prd ? await getSkillConfig(prd.project) : null;
    // Prefer the regen-specific model; fall back to the generation model.
    const prototypeModel = skillConfig?.designPrototypeRegenBedrockModelId
      ?? skillConfig?.designPrototypeBedrockModelId
      ?? undefined;
    const prototypeMaxTokens = skillConfig?.designPrototypeRegenBedrockMaxTokens
      ?? skillConfig?.designPrototypeBedrockMaxTokens
      ?? undefined;
    const prototypeTimeoutMs = skillConfig?.designPrototypeBedrockTimeoutMs ?? undefined;

    const comments = await db
      .select()
      .from(designPrototypeComments)
      .where(
        and(
          eq(designPrototypeComments.prototypeId, prototypeId),
          eq(designPrototypeComments.resolved, false),
        )
      );
    const unresolvedTexts = comments.map(c => c.text);

    let regenScreenshot: { base64: string; mediaType: string } | undefined;
    if (targetRoute) {
      try {
        const { getScreenshotByRoute } = await import('./pageScreenshotService');
        const ss = await getScreenshotByRoute(targetRoute);
        if (ss) regenScreenshot = { base64: ss.imageBase64, mediaType: ss.mediaType };
      } catch (err) {
        console.warn('[designPrototypeService] Page screenshot lookup (regen) failed:', err);
      }
    }

    const rawHtml = await regenerateDesignPrototypeHtml(
      proto.mockHtml,
      feedback,
      unresolvedTexts,
      prototypeModel,
      prototypeMaxTokens,
      targetRoute,
      undefined,
      targetStates,
      prototypeTimeoutMs,
      regenScreenshot,
    );

    const html = sanitizeMockHtml(rawHtml);
    const newVersion = proto.mockVersion + 1;
    const now = new Date().toISOString();

    const currentEntry: DesignPrototypeHistoryEntry = {
      version: proto.mockVersion,
      html: proto.mockHtml,
      feedback,
      createdAt: now,
    };

    const newEntry: DesignPrototypeHistoryEntry = {
      version: newVersion,
      html,
      createdAt: now,
    };

    const updatedHistory = [...proto.history];
    const existingIdx = updatedHistory.findIndex(h => h.version === proto.mockVersion);
    if (existingIdx >= 0) {
      updatedHistory[existingIdx] = { ...updatedHistory[existingIdx], feedback };
    } else {
      updatedHistory.push(currentEntry);
    }
    updatedHistory.push(newEntry);

    await db
      .update(designPrototypes)
      .set({
        mockHtml: html,
        mockVersion: newVersion,
        history: updatedHistory,
        status: 'pending_review',
        reviewerId: null,
        reviewComment: null,
        reviewedAt: null,
        generationError: null,
        updatedAt: now,
      })
      .where(eq(designPrototypes.id, prototypeId));
  } catch (err: any) {
    console.error(`[designPrototypeService] Regeneration error for ${prototypeId}:`, err);
    await db
      .update(designPrototypes)
      .set({
        status: 'generation_failed',
        generationError: err.message ?? 'Unknown error',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(designPrototypes.id, prototypeId));
  }
}

export async function retryPrototype(prototypeId: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) throw new Error(`Prototype ${prototypeId} not found`);

  const prd = await db.query.prds.findFirst({ where: eq(prds.id, proto.prdId) });
  if (!prd) throw new Error(`PRD ${proto.prdId} not found`);

  const features = extractFeatures(prd.backlogJson);
  const feature = features[proto.featureIndex];
  if (!feature) throw new Error(`Feature at index ${proto.featureIndex} not found`);

  const planRow = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, proto.prdId) });
  const planFeature = planRow?.features?.find(f => f.featureIndex === proto.featureIndex);

  const { getSkillConfig } = await import('./projectSettingsService');
  const skillConfig = await getSkillConfig(prd.project);
  const prototypeModel = skillConfig?.designPrototypeBedrockModelId ?? undefined;
  const prototypeMaxTokens = skillConfig?.designPrototypeBedrockMaxTokens ?? undefined;
  const prototypeTimeoutMs = skillConfig?.designPrototypeBedrockTimeoutMs ?? undefined;

  await db
    .update(designPrototypes)
    .set({ status: 'generating', generationError: null, updatedAt: new Date().toISOString() })
    .where(eq(designPrototypes.id, prototypeId));

  generateSinglePrototype(prototypeId, feature, prototypeModel, prototypeMaxTokens, planFeature, prototypeTimeoutMs).catch(err => {
    console.error(`[designPrototypeService] Retry generation failed for ${prototypeId}:`, err);
  });
}

// ── Stuck-generation recovery ─────────────────────────────────────────────────

/**
 * Flip design prototypes that have been stuck in a transient status
 * (`generating`/`regenerating`) for longer than `thresholdMs` to
 * `generation_failed`. Prototypes are one-shot Bedrock calls with no chat thread
 * to rehydrate, so a server restart or a hung model call orphans the row forever.
 * Marking them failed surfaces the existing "Retry Generation" affordance.
 *
 * The threshold must comfortably exceed normal generation time so a slow-but-live
 * generation is never reset out from under itself. Returns the number reset.
 */
export async function failStalePrototypes(thresholdMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();
  const reset = await db
    .update(designPrototypes)
    .set({
      status: 'generation_failed',
      generationError:
        'Generation was interrupted (likely a server restart or a timed-out model call). Click Retry to run it again.',
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        inArray(designPrototypes.status, ['generating', 'regenerating']),
        lt(designPrototypes.updatedAt, cutoff),
      ),
    )
    .returning({ id: designPrototypes.id, featureName: designPrototypes.featureName });

  for (const row of reset) {
    console.warn(
      `[designPrototypeService] Reset stale prototype "${row.featureName}" (id=${row.id}) to generation_failed`,
    );
  }
  return reset.length;
}

/**
 * Manual unblock: force a prototype currently stuck `generating`/`regenerating`
 * to `generation_failed` so the user doesn't have to wait for the recovery loop.
 * The existing "Retry Generation" button then re-runs it from scratch.
 */
export async function resetStuckPrototype(prototypeId: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) {
    throw Object.assign(new Error(`Prototype ${prototypeId} not found`), { status: 404 });
  }
  if (proto.status !== 'generating' && proto.status !== 'regenerating') {
    throw Object.assign(
      new Error(`Cannot reset a prototype in status '${proto.status}'`),
      { status: 409 },
    );
  }

  await db
    .update(designPrototypes)
    .set({
      status: 'generation_failed',
      generationError: 'Generation reset by user. Click Retry to run it again.',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designPrototypes.id, prototypeId));
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listPrototypesForPrd(prdId: string): Promise<DesignPrototypeSummary[]> {
  const rows = await db
    .select()
    .from(designPrototypes)
    .where(eq(designPrototypes.prdId, prdId))
    .orderBy(asc(designPrototypes.featureIndex));

  return rows.map(toSummary);
}

export async function listPrototypes(opts: {
  status?: string;
  project?: string;
  author?: string;
  requestUserId?: string;
}): Promise<DesignPrototypeSummary[]> {
  const conditions: SQL[] = [];
  if (opts.status) {
    conditions.push(eq(designPrototypes.status, opts.status));
  }
  if (opts.project) {
    conditions.push(eq(prds.project, opts.project));
  }
  if (opts.author === 'me' && opts.requestUserId) {
    conditions.push(eq(designPrototypes.authorId, opts.requestUserId));
  }

  const rows = await db
    .select({
      proto: designPrototypes,
      prdTitle: prds.title,
    })
    .from(designPrototypes)
    .innerJoin(prds, eq(designPrototypes.prdId, prds.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(designPrototypes.updatedAt));

  return rows.map(r => ({ ...toSummary(r.proto), prdTitle: r.prdTitle }));
}

export async function deletePrototype(id: string): Promise<void> {
  await db.delete(designPrototypes).where(eq(designPrototypes.id, id));
}

export async function updatePrototypeHtml(id: string, html: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, id),
  });
  if (!proto) throw Object.assign(new Error(`Prototype ${id} not found`), { status: 404 });

  const now = new Date().toISOString();

  // Push the current version to history so the reviewer can undo boundary edits.
  const updatedHistory = [...(proto.history ?? [])];
  if (proto.mockHtml) {
    const existingIdx = updatedHistory.findIndex(h => h.version === proto.mockVersion);
    if (existingIdx < 0) {
      updatedHistory.push({
        version: proto.mockVersion,
        html: proto.mockHtml,
        feedback: 'Before boundary edit',
        createdAt: now,
      });
    }
  }

  const newVersion = proto.mockVersion + 1;
  updatedHistory.push({ version: newVersion, html, createdAt: now });

  await db
    .update(designPrototypes)
    .set({
      mockHtml: html,
      mockVersion: newVersion,
      history: updatedHistory,
      updatedAt: now,
    })
    .where(eq(designPrototypes.id, id));
}

export async function getPrototype(id: string): Promise<DesignPrototype | null> {
  const row = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, id),
  });
  if (!row) return null;

  const prd = await db.query.prds.findFirst({ where: eq(prds.id, row.prdId) });
  const features = prd ? extractFeatures(prd.backlogJson) : [];
  const feature = features[row.featureIndex];
  const planRow = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, row.prdId) });
  const planFeature = planRow?.features?.find(f => f.featureIndex === row.featureIndex);
  const pbiRequirements = feature
    ? scopePbiRequirementsForFeature(feature, planFeature)
    : [];

  return {
    ...toSummary(row),
    mockHtml: row.mockHtml,
    history: row.history ?? [],
    pbiRequirements,
  };
}

// ── Review ──────────────────────────────────────────────────────────────────

export async function reviewPrototype(
  prototypeId: string,
  reviewerId: string,
  action: 'approve' | 'revision_requested',
  comment?: string,
): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) throw new Error(`Prototype ${prototypeId} not found`);
  if (proto.status !== 'pending_review') throw Object.assign(new Error(`Cannot review a prototype in status '${proto.status}'`), { status: 409 });

  // Only a designated design-prototype approver (or an admin) may approve/reject.
  // These approvers are distinct from PRD approvers; everyone else can view only.
  const admin = await isAdminUser(reviewerId);
  const assigned = await isAssignedApprover(proto.prdId, 'design_prototype', reviewerId);
  if (!assigned && !admin) {
    throw Object.assign(new Error('You are not a designated design prototype approver'), { status: 403 });
  }

  const now = new Date().toISOString();
  await db
    .update(designPrototypes)
    .set({
      status: action === 'approve' ? 'approved' : 'revision_requested',
      reviewerId,
      reviewComment: comment ?? null,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(eq(designPrototypes.id, prototypeId));

  if (action === 'approve') {
    await checkAllApprovedAndProceed(proto.prdId);
  }
}

export async function reopenPrototypeForReview(prototypeId: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) {
    throw Object.assign(new Error(`Prototype ${prototypeId} not found`), { status: 404 });
  }
  if (proto.status !== 'approved') {
    throw Object.assign(
      new Error(`Cannot reopen a prototype in status '${proto.status}'`),
      { status: 409 },
    );
  }

  const existingDocs = await db
    .select({ id: designDocs.id })
    .from(designDocs)
    .where(eq(designDocs.prdId, proto.prdId))
    .limit(1);

  if (existingDocs.length > 0) {
    throw Object.assign(
      new Error('Cannot reopen — design docs have already been created for this PRD'),
      { status: 409 },
    );
  }

  await db
    .update(designPrototypes)
    .set({
      status: 'pending_review',
      reviewerId: null,
      reviewComment: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designPrototypes.id, prototypeId));
}

export async function checkAllApprovedAndProceed(prdId: string): Promise<boolean> {
  const all = await db
    .select()
    .from(designPrototypes)
    .where(eq(designPrototypes.prdId, prdId));

  const allApproved = all.length > 0 && all.every(p => p.status === 'approved');

  if (allApproved) {
    console.log(`[designPrototypeService] All prototypes approved for PRD ${prdId} — triggering Design Doc generation`);
    triggerDesignDocGeneration(prdId).catch(err => {
      console.error(`[designPrototypeService] Design Doc generation failed for PRD ${prdId}:`, err);
    });
  }

  return allApproved;
}

async function triggerDesignDocGeneration(prdId: string): Promise<void> {
  const { createDesignDoc, startDesignDocWatcher } = await import('./designDocService');
  const { createThread } = await import('./chatAgentService');
  const { getSkillConfig } = await import('./projectSettingsService');
  const { getDefaultModel } = await import('./appSettingsService');

  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prd) return;

  const skillConfig = await getSkillConfig(prd.project);
  const globalModel = await getDefaultModel();

  // Load the reviewed design plan so the design doc receives structured decisions
  // (decision, route, components, brief) instead of prototype HTML. The prototype
  // HTML served the human reviewer; the design doc needs the actual React source.
  const planRow = await db.query.designPlans.findFirst({
    where: eq(designPlans.prdId, prdId),
  });
  const planFeatures = planRow?.features ?? [];

  const contextParts: string[] = [];

  if (planFeatures.length > 0) {
    contextParts.push('\n# Approved Design Plan');
    contextParts.push('The design plan below was reviewed and approved. It specifies exactly what to build and where.\n');
    for (const f of planFeatures) {
      const parts = [`## Feature: ${f.featureName}`];
      parts.push(`- **Decision:** ${f.decision}`);
      if (f.targetRoute) parts.push(`- **Target route:** ${f.targetRoute}`);
      if (f.targetPageTitle) parts.push(`- **Page title:** ${f.targetPageTitle}`);
      if (f.layoutPattern) parts.push(`- **Layout pattern:** ${f.layoutPattern}`);
      if (f.primaryComponents?.length)
        parts.push(`- **Primary components:** ${f.primaryComponents.join(', ')}`);
      if (f.states?.length) parts.push(`- **States:** ${f.states.join(', ')}`);
      if (f.rationale) parts.push(`- **Rationale:** ${f.rationale}`);
      if (f.notes?.trim()) parts.push(`- **Reviewer notes:** ${f.notes.trim()}`);
      if (f.pbiContributions?.length) {
        parts.push('\n**PBI contributions (what to add where):**');
        for (const c of f.pbiContributions)
          parts.push(`- ${c.pbiTitle}: ${c.contribution}`);
      }
      if (f.designBrief) parts.push(`\n**Design brief:**\n${f.designBrief}`);
      contextParts.push(parts.join('\n'));
    }
  }

  // Fetch actual React source for update-page features so the design doc can
  // reference the real codebase structure rather than the prototype's HTML guess.
  const updatePageFeatures = planFeatures.filter(
    (f): f is typeof f & { targetRoute: string } => f.decision === 'update-page' && !!f.targetRoute,
  );
  if (updatePageFeatures.length > 0) {
    try {
      const { fetchExistingPageContext } = await import('./designSystemService');
      contextParts.push('\n# Existing Page Context (from MaxView codebase)');
      contextParts.push(
        'The source code below is the ACTUAL existing React implementation. ' +
        'Use this as the authoritative reference. DO NOT rewrite these files.\n',
      );
      for (const f of updatePageFeatures) {
        const pageContext = await fetchExistingPageContext(f.targetRoute, f.featureName);
        if (pageContext.trim()) {
          contextParts.push(`## Existing page for: ${f.featureName} (route: ${f.targetRoute})\n`);
          contextParts.push(pageContext);
        }
      }
    } catch (err) {
      console.warn('[designPrototypeService] Failed to fetch existing page context:', err);
    }
  }

  // Extract the approved new-feature content from each prototype. Only the
  // content between <!-- NEW_FEATURE:START --> and <!-- NEW_FEATURE:END -->
  // markers is included — this is what the reviewer approved visually.
  const approvedPrototypes = await db
    .select()
    .from(designPrototypes)
    .where(
      and(
        eq(designPrototypes.prdId, prdId),
        eq(designPrototypes.status, 'approved'),
      ),
    )
    .orderBy(asc(designPrototypes.featureIndex));

  const protosWithHtml = approvedPrototypes.filter(p => p.mockHtml);

  if (protosWithHtml.length > 0) {
    const extractStateScopedHtml = (html: string): string => {
      const stateBlockRe = /<!--\s*STATE:[a-z_]+:START\s*-->[\s\S]*?<!--\s*STATE:[a-z_]+:END\s*-->/gi;
      const stateBlocks = html.match(stateBlockRe);
      return stateBlocks && stateBlocks.length > 0 ? stateBlocks.join('\n') : html;
    };
    const dedupeFragments = (fragments: string[]): string[] => {
      const unique: string[] = [];
      const seen = new Set<string>();
      for (const fragment of fragments) {
        const trimmed = fragment.trim();
        if (!trimmed) continue;
        // Normalize whitespace so copy-appended duplicates are collapsed reliably.
        const key = trimmed.replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(trimmed);
      }
      return unique;
    };
    const newFeatureRe = /<!--\s*NEW_FEATURE:START\s*-->([\s\S]*?)<!--\s*NEW_FEATURE:END\s*-->/gi;
    const extracted: Array<{ featureName: string; fragments: string[] }> = [];
    const noMarkers: Array<{ featureName: string; html: string }> = [];

    for (const p of protosWithHtml) {
      const matches: string[] = [];
      const htmlForExtraction = extractStateScopedHtml(p.mockHtml!);
      let m: RegExpExecArray | null;
      while ((m = newFeatureRe.exec(htmlForExtraction)) !== null) matches.push(m[1].trim());
      newFeatureRe.lastIndex = 0;
      const uniqueMatches = dedupeFragments(matches);

      if (uniqueMatches.length > 0) {
        extracted.push({ featureName: p.featureName, fragments: uniqueMatches });
      } else {
        noMarkers.push({ featureName: p.featureName, html: htmlForExtraction });
      }
    }

    if (extracted.length > 0) {
      contextParts.push('\n# Approved New Feature Designs (from reviewed prototypes)');
      contextParts.push('The HTML fragments below were extracted from the approved design prototypes. They show ONLY the new feature content that was reviewed and approved — not the existing page. Implement these visual designs faithfully.\n');
      for (const ef of extracted) {
        contextParts.push(`## Approved design for: ${ef.featureName}\n`);
        contextParts.push('```html');
        contextParts.push(ef.fragments.join('\n\n'));
        contextParts.push('```\n');
      }
    }

    // Fallback: for prototypes without NEW_FEATURE markers, include the full
    // prototype HTML so the design doc still has visual context. This covers
    // new-page features (entire page is "new") and prototypes where the reviewer
    // didn't use the boundary editor.
    if (noMarkers.length > 0) {
      contextParts.push('\n# Full Prototype Designs (no boundary markers — treat entire content as the new feature)');
      contextParts.push('The prototypes below do not have explicit NEW_FEATURE boundary markers. The ENTIRE content area is the new feature to implement.\n');
      for (const p of noMarkers) {
        contextParts.push(`## Prototype for: ${p.featureName}\n`);
        contextParts.push('```html');
        contextParts.push(p.html);
        contextParts.push('```\n');
      }
    }
  }

  contextParts.push('\n## CRITICAL — Existing Code Protection Rules');
  contextParts.push('');
  contextParts.push('The design doc and any generated code MUST follow these rules with ZERO exceptions:');
  contextParts.push('');
  contextParts.push('1. **DO NOT modify, replace, refactor, or restructure ANY existing page code.** The sidebar navigation, header bar, page layout, existing tabs, existing grids, existing forms, and all other pre-existing UI elements are OFF LIMITS.');
  contextParts.push('2. **ONLY implement the NEW feature component** as described in the design plan above. Everything else is existing code that must not be touched.');
  contextParts.push('3. **DO NOT generate code for the sidebar, header, navigation, or page shell.** These are shared application components that already exist.');
  contextParts.push('4. **For update-page features:** Add the new component INTO the existing page by importing it and placing it at the correct location (e.g. adding a new tab, appending a column to an existing grid, inserting a section). DO NOT rewrite or replace the existing page component.');
  contextParts.push('5. **For new-page features:** Create ONLY the new page component and its route registration. DO NOT modify the sidebar navigation component or header — route registration handles menu visibility automatically.');
  contextParts.push('6. **Test cases must ONLY test the new feature behavior.** Do not write tests that assert on existing page structure, existing sidebar items, or existing navigation behavior.');
  contextParts.push('7. **Output policy:** Use prototype HTML fragments as internal visual guidance only. DO NOT paste raw prototype HTML, full-page mock markup, `NEW_FEATURE` markers, or `STATE:*` marker blocks into the final tech spec output.');

  const prototypesContext = contextParts.join('\n');

  const prdFreeformContext = [
    '# PRD Content',
    prd.content,
    ...(prd.backlogJson
      ? ['\n# Backlog', JSON.stringify(prd.backlogJson, null, 2)]
      : []),
    ...(prototypesContext ? [prototypesContext] : []),
  ].join('\n');

  if (skillConfig?.designDocQaSkillPath) {
    const qaModel = skillConfig.designDocQaModel ?? globalModel;
    const qaThread = await createThread(prd.authorId, {
      project: prd.project,
      repo: skillConfig.skillRepo,
      branch: skillConfig.skillBranch ?? 'main',
      skillPath: skillConfig.designDocQaSkillPath,
      freeformContext: prdFreeformContext,
      model: qaModel,
    });

    await createDesignDoc({
      prdId,
      project: prd.project,
      userId: prd.authorId,
      qaChatThreadId: qaThread.id,
      title: prd.title,
      status: 'interviewing',
    });
  } else {
    const designDocSkillPath = skillConfig?.designDocSkillPath ?? undefined;
    const model = skillConfig?.designDocModel ?? globalModel;

    const thread = await createThread(prd.authorId, {
      project: prd.project,
      repo: skillConfig?.skillRepo ?? prd.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillPath: designDocSkillPath,
      freeformContext: prdFreeformContext,
      model,
    });

    const { designDocId } = await createDesignDoc({
      prdId,
      project: prd.project,
      userId: prd.authorId,
      chatThreadId: thread.id,
      title: prd.title,
    });

    startDesignDocWatcher(designDocId, thread.id);
  }
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function listComments(prototypeId: string): Promise<DesignPrototypeComment[]> {
  const rows = await db
    .select()
    .from(designPrototypeComments)
    .where(eq(designPrototypeComments.prototypeId, prototypeId))
    .orderBy(asc(designPrototypeComments.createdAt));

  return rows.map(r => ({
    id: r.id,
    prototypeId: r.prototypeId,
    authorId: r.authorId,
    authorName: resolveUserName(r.authorId),
    text: r.text,
    pinX: r.pinX,
    pinY: r.pinY,
    mockVersion: r.mockVersion,
    resolved: r.resolved,
    resolvedBy: r.resolvedBy,
    createdAt: r.createdAt,
  }));
}

export async function addComment(
  prototypeId: string,
  authorId: string,
  text: string,
  mockVersion: number,
  pinX?: number,
  pinY?: number,
): Promise<DesignPrototypeComment> {
  const [row] = await db
    .insert(designPrototypeComments)
    .values({
      prototypeId,
      authorId,
      text,
      mockVersion,
      pinX: pinX ?? null,
      pinY: pinY ?? null,
    })
    .returning();

  return {
    id: row.id,
    prototypeId: row.prototypeId,
    authorId: row.authorId,
    authorName: resolveUserName(row.authorId),
    text: row.text,
    pinX: row.pinX,
    pinY: row.pinY,
    mockVersion: row.mockVersion,
    resolved: row.resolved,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
  };
}

export async function resolveComment(commentId: string, resolvedBy: string): Promise<void> {
  await db
    .update(designPrototypeComments)
    .set({ resolved: true, resolvedBy })
    .where(eq(designPrototypeComments.id, commentId));
}
