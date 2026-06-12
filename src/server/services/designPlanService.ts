import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designPlans, prds } from '../db/schema';
import { isAdminUser } from '../utils/rbacHelpers';
import { isAssignedApprover } from './documentApprovalService';
import { extractFeatures, extractPbiRequirements } from './designPrototypeService';
import type {
  DesignPlan,
  DesignPlanFeature,
  DesignPlanResponse,
  DesignPlanHistoryEntry,
} from '../../shared/types/designPlan';
import type { GenerateDesignPlanInput } from './bedrockService';

function toDesignPlan(row: typeof designPlans.$inferSelect): DesignPlan {
  return {
    id: row.id,
    prdId: row.prdId,
    status: row.status as DesignPlan['status'],
    version: row.version,
    features: row.features ?? [],
    backlogHash: row.backlogHash,
    generationError: row.generationError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function computeBacklogHash(backlogJson: unknown): string {
  return createHash('sha256').update(JSON.stringify(backlogJson ?? null)).digest('hex');
}

function buildGenerationInput(prdTitle: string, backlogJson: unknown): GenerateDesignPlanInput {
  const features = extractFeatures(backlogJson);
  return {
    prdTitle,
    features: features.map((feature, index) => ({
      featureIndex: index,
      featureName: feature.title,
      featureDescription: feature.description,
      targetRoute: feature.route?.trim() || undefined,
      pbis: extractPbiRequirements(feature).map((pbi) => ({
        title: pbi.title,
        description: pbi.description,
        acceptanceCriteria: pbi.acceptanceCriteria,
        userTypes: pbi.userTypes,
      })),
    })),
  };
}

/** Only assigned design-prototype approvers (or admins) may edit/regenerate/generate from a plan. */
export async function assertPlanApprover(prdId: string, userId: string): Promise<void> {
  const admin = await isAdminUser(userId);
  if (admin) return;
  const assigned = await isAssignedApprover(prdId, 'design_prototype', userId);
  if (!assigned) {
    throw Object.assign(new Error('You are not a designated design plan approver'), { status: 403 });
  }
}

export async function getPlanForPrd(prdId: string): Promise<DesignPlanResponse | null> {
  const row = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, prdId) });
  if (!row) return null;
  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  const currentHash = prd ? computeBacklogHash(prd.backlogJson) : null;
  const stale = Boolean(row.backlogHash && currentHash && row.backlogHash !== currentHash);
  return { plan: toDesignPlan(row), stale };
}

export async function getPlanById(planId: string): Promise<DesignPlan | null> {
  const row = await db.query.designPlans.findFirst({ where: eq(designPlans.id, planId) });
  return row ? toDesignPlan(row) : null;
}

async function runPlanGeneration(prdId: string): Promise<void> {
  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prd) throw new Error(`PRD ${prdId} not found`);

  const { getSkillConfig } = await import('./projectSettingsService');
  const skillConfig = await getSkillConfig(prd.project);
  const modelId = skillConfig?.designPlanBedrockModelId ?? undefined;
  const maxTokens = skillConfig?.designPlanBedrockMaxTokens ?? undefined;

  try {
    const { generateDesignPlanForPrd } = await import('./bedrockService');
    const input = buildGenerationInput(prd.title, prd.backlogJson);
    const features = await generateDesignPlanForPrd(input, modelId, maxTokens);

    const now = new Date().toISOString();
    const historyEntry: DesignPlanHistoryEntry = { version: 1, features, editedBy: 'system', createdAt: now };
    await db
      .update(designPlans)
      .set({
        status: 'ready',
        version: 1,
        features,
        backlogHash: computeBacklogHash(prd.backlogJson),
        history: [historyEntry],
        generationError: null,
        updatedAt: now,
      })
      .where(eq(designPlans.prdId, prdId));
  } catch (err: any) {
    console.error(`[designPlanService] Plan generation failed for PRD ${prdId}:`, err);
    await db
      .update(designPlans)
      .set({
        status: 'generation_failed',
        generationError: err?.message ?? 'Unknown error',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(designPlans.prdId, prdId));
  }
}

/**
 * Entry point invoked on PRD approval. Creates (or resets) the per-PRD plan row to
 * `generating`, assigns the design-prototype reviewer pool (which notifies them), and
 * kicks off background plan generation.
 */
export async function generateDesignPlan(prdId: string): Promise<string> {
  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prd) throw new Error(`PRD ${prdId} not found`);

  const now = new Date().toISOString();
  const [row] = await db
    .insert(designPlans)
    .values({ prdId, status: 'generating', version: 1, features: [], history: [], updatedAt: now })
    .onConflictDoUpdate({
      target: designPlans.prdId,
      set: { status: 'generating', generationError: null, updatedAt: now },
    })
    .returning({ id: designPlans.id });

  // Assign the design-prototype reviewer pool (kickoff approvers, else project pool) and notify
  // them — these are the only users who may edit the plan and generate designs from it.
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
    console.error(`[designPlanService] Failed to assign/notify plan reviewers for PRD ${prdId}:`, err);
  }

  runPlanGeneration(prdId).catch((err) => {
    console.error(`[designPlanService] Background plan generation failed for PRD ${prdId}:`, err);
  });

  return row.id;
}

/** Regenerate the plan from the current PRD backlog. Approver-gated. */
export async function regeneratePlan(prdId: string, userId: string): Promise<void> {
  await assertPlanApprover(prdId, userId);
  const existing = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, prdId) });
  if (!existing) throw Object.assign(new Error('No design plan to regenerate'), { status: 404 });

  await db
    .update(designPlans)
    .set({ status: 'generating', generationError: null, updatedAt: new Date().toISOString() })
    .where(eq(designPlans.prdId, prdId));

  runPlanGeneration(prdId).catch((err) => {
    console.error(`[designPlanService] Background plan regeneration failed for PRD ${prdId}:`, err);
  });
}

/** Save reviewer edits to the plan features. Approver-gated. */
export async function savePlan(planId: string, features: DesignPlanFeature[], userId: string): Promise<DesignPlan> {
  const row = await db.query.designPlans.findFirst({ where: eq(designPlans.id, planId) });
  if (!row) throw Object.assign(new Error('Design plan not found'), { status: 404 });
  await assertPlanApprover(row.prdId, userId);

  if (!Array.isArray(features)) {
    throw Object.assign(new Error('features must be an array'), { status: 400 });
  }

  const now = new Date().toISOString();
  const newVersion = row.version + 1;
  const history = [...(row.history ?? []), { version: newVersion, features, editedBy: userId, createdAt: now }];

  const [updated] = await db
    .update(designPlans)
    .set({
      features,
      version: newVersion,
      status: row.status === 'consumed' ? 'consumed' : 'ready',
      history,
      updatedAt: now,
    })
    .where(eq(designPlans.id, planId))
    .returning();

  return toDesignPlan(updated);
}

/** The Generate button: consume the plan and kick off HTML prototype generation. Approver-gated. */
export async function generatePrototypesFromPlan(planId: string, userId: string): Promise<string[]> {
  const row = await db.query.designPlans.findFirst({ where: eq(designPlans.id, planId) });
  if (!row) throw Object.assign(new Error('Design plan not found'), { status: 404 });
  await assertPlanApprover(row.prdId, userId);
  if (row.status === 'generating') {
    throw Object.assign(new Error('Plan is still generating'), { status: 409 });
  }

  const { generatePrototypesForPrd } = await import('./designPrototypeService');
  const ids = await generatePrototypesForPrd(row.prdId);

  await db
    .update(designPlans)
    .set({ status: 'consumed', updatedAt: new Date().toISOString() })
    .where(eq(designPlans.id, planId));

  return ids;
}
