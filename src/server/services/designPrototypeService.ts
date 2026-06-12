import { eq, and, asc, desc, type SQL } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designPrototypes, designPrototypeComments, designPlans, prds } from '../db/schema';
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

export async function generatePrototypesForPrd(prdId: string): Promise<string[]> {
  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prd) throw new Error(`PRD ${prdId} not found`);

  const { getSkillConfig } = await import('./projectSettingsService');
  const skillConfig = await getSkillConfig(prd.project);
  const prototypeModel = skillConfig?.designPrototypeBedrockModelId ?? undefined;
  const prototypeMaxTokens = skillConfig?.designPrototypeBedrockMaxTokens ?? undefined;

  const features = extractFeatures(prd.backlogJson);
  if (features.length === 0) {
    console.warn(`[designPrototypeService] No features found in PRD ${prdId} backlogJson`);
    return [];
  }

  // Load the reviewed/edited design plan (when present) so its decisions steer generation.
  const planRow = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, prdId) });
  const planFeatures = planRow?.features ?? [];

  const ids: string[] = [];

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const planFeature = planFeatures.find(f => f.featureIndex === i);
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

    generateSinglePrototype(row.id, feature, prototypeModel, prototypeMaxTokens, planFeature).catch(err => {
      console.error(`[designPrototypeService] Background generation failed for ${row.id}:`, err);
    });
  }

  // Reviewer assignment + notification now happens at design-plan generation
  // (see designPlanService.generateDesignPlan); the plan is the entry point users see first.

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

async function generateSinglePrototype(prototypeId: string, feature: BacklogFeature, modelId?: string, maxTokens?: number, planFeature?: DesignPlanFeature): Promise<void> {
  try {
    const { generateDesignPrototypeHtml } = await import('./bedrockService');

    const pbis = extractPbiRequirements(feature);
    // The reviewed plan is authoritative: prefer its route decision over the raw backlog route.
    const planRoute = planFeature?.decision === 'update-page' ? planFeature.targetRoute?.trim() : undefined;
    const targetRoute = planRoute || feature.route?.trim() || undefined;

    const rawHtml = await generateDesignPrototypeHtml({
      featureName: feature.title,
      featureDescription: feature.description,
      pbis,
      targetRoute,
      plan: planFeatureToInput(planFeature),
    }, modelId, maxTokens);

    const html = sanitizeMockHtml(rawHtml);
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

    const rawHtml = await regenerateDesignPrototypeHtml(
      proto.mockHtml,
      feedback,
      unresolvedTexts,
      prototypeModel,
      prototypeMaxTokens,
      targetRoute,
      undefined,
      targetStates,
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

  await db
    .update(designPrototypes)
    .set({ status: 'generating', generationError: null, updatedAt: new Date().toISOString() })
    .where(eq(designPrototypes.id, prototypeId));

  generateSinglePrototype(prototypeId, feature, prototypeModel, prototypeMaxTokens, planFeature).catch(err => {
    console.error(`[designPrototypeService] Retry generation failed for ${prototypeId}:`, err);
  });
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

  // Pull the approved prototypes (one per feature) so the design doc is grounded
  // in the actual UI/UX that was reviewed and signed off, not just the PRD text.
  const approvedPrototypes = await db
    .select()
    .from(designPrototypes)
    .where(
      and(
        eq(designPrototypes.prdId, prdId),
        eq(designPrototypes.status, 'approved'),
      )
    )
    .orderBy(asc(designPrototypes.featureIndex));

  const prototypesContext = approvedPrototypes.length > 0
    ? [
        '\n# Approved Design Prototypes',
        'The HTML prototypes below were reviewed and approved for each feature. Treat them as the source of truth for the UI/UX (layout, components, states, and visual styling) the design doc must describe.',
        ...approvedPrototypes
          .filter(p => p.mockHtml)
          .map(p => `\n## Prototype — ${p.featureName} (v${p.mockVersion})\n\n\`\`\`html\n${p.mockHtml}\n\`\`\``),
      ].join('\n')
    : '';

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
