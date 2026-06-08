import { eq, and, asc, desc, type SQL } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designPrototypes, designPrototypeComments, prds } from '../db/schema';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import { isAdminUser } from '../utils/rbacHelpers';
import { isAssignedApprover } from './documentApprovalService';
import type {
  DesignPrototypeSummary,
  DesignPrototype,
  DesignPrototypeComment,
  DesignPrototypeHistoryEntry,
  PbiRequirement,
} from '../../shared/types/designPrototype';

interface BacklogItem {
  id?: string;
  type?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string | string[];
  definitionOfDone?: string[];
  userStory?: {
    persona?: string;
    iWant?: string;
    soThat?: string;
  };
}

interface BacklogFeature {
  title: string;
  description?: string;
  items?: BacklogItem[];
  pbis?: BacklogItem[];
}

interface BacklogJson {
  epics?: Array<{
    features?: BacklogFeature[];
  }>;
  features?: BacklogFeature[];
}

function extractFeatures(backlogJson: unknown): BacklogFeature[] {
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

function extractPbiRequirements(feature: BacklogFeature): PbiRequirement[] {
  const items = feature.items ?? feature.pbis ?? [];
  return items.map(item => {
    let ac: string | undefined;
    if (item.acceptanceCriteria) {
      ac = Array.isArray(item.acceptanceCriteria)
        ? item.acceptanceCriteria.join('\n- ')
        : item.acceptanceCriteria;
    } else if (item.definitionOfDone?.length) {
      ac = item.definitionOfDone.join('\n- ');
    }

    let description = item.description;
    if (!description && item.userStory) {
      const us = item.userStory;
      description = `As a ${us.persona ?? 'user'}, I want to ${us.iWant ?? '...'} so that ${us.soThat ?? '...'}`;
    }

    return { title: item.title, description, acceptanceCriteria: ac };
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
  const prototypeModel = skillConfig?.designPrototypeModel ?? undefined;

  const features = extractFeatures(prd.backlogJson);
  if (features.length === 0) {
    console.warn(`[designPrototypeService] No features found in PRD ${prdId} backlogJson`);
    return [];
  }

  const ids: string[] = [];

  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
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

    generateSinglePrototype(row.id, feature, prototypeModel).catch(err => {
      console.error(`[designPrototypeService] Background generation failed for ${row.id}:`, err);
    });
  }

  // Assign kick-off prototype reviewers (or fall back to the project pool) and notify them.
  try {
    const { getApproverUserIds } = await import('./projectSettingsService');
    const { assignApprovers } = await import('./documentApprovalService');
    const kickoffIds = prd.designPrototypeApproverIds?.filter(Boolean) ?? [];
    const poolIds = kickoffIds.length > 0
      ? kickoffIds
      : await getApproverUserIds(prd.project, 'design_prototype');
    if (poolIds.length > 0) {
      await assignApprovers(prdId, 'design_prototype', poolIds, prd.authorId);
    }
  } catch (err) {
    console.error(`[designPrototypeService] Failed to assign/notify prototype reviewers for PRD ${prdId}:`, err);
  }

  return ids;
}

async function generateSinglePrototype(prototypeId: string, feature: BacklogFeature, modelId?: string): Promise<void> {
  try {
    const { generateDesignPrototypeHtml } = await import('./bedrockService');

    const pbis = extractPbiRequirements(feature);

    const rawHtml = await generateDesignPrototypeHtml({
      featureName: feature.title,
      featureDescription: feature.description,
      pbis,
    }, modelId);

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

export async function regeneratePrototype(prototypeId: string, feedback: string): Promise<void> {
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
    const { getSkillConfig } = await import('./projectSettingsService');
    const skillConfig = prd ? await getSkillConfig(prd.project) : null;
    const prototypeModel = skillConfig?.designPrototypeModel ?? undefined;

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

  const { getSkillConfig } = await import('./projectSettingsService');
  const skillConfig = await getSkillConfig(prd.project);
  const prototypeModel = skillConfig?.designPrototypeModel ?? undefined;

  await db
    .update(designPrototypes)
    .set({ status: 'generating', generationError: null, updatedAt: new Date().toISOString() })
    .where(eq(designPrototypes.id, prototypeId));

  generateSinglePrototype(prototypeId, feature, prototypeModel).catch(err => {
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
  const pbiRequirements = feature ? extractPbiRequirements(feature) : [];

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
