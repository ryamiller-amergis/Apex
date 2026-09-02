/**
 * AI Usage recording service.
 *
 * recordAiUsage() is intentionally fire-and-forget — it never throws or
 * blocks the calling code, matching the pattern of pgInsertMessage().
 *
 * computeCost() reads the ai_pricing catalog to turn token counts into
 * a USD cost figure. Falls back to 0 when the model has no pricing entry.
 */
import { db } from '../db/drizzle';
import { adrs, aiPricing, aiUsageEvents, designDocs, interviews, prds } from '../db/schema';
import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import type { RecordUsageInput, AiFeature, AiUsageStatus } from '../../shared/types/aiCostAnalytics';

// Estimate: ~4 chars per token (GPT-4 heuristic, good enough for allocation)
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Exact model id, then one hyphen-suffix strip (e.g. composer-2.5-fast → composer-2.5). */
export function modelIdPricingCandidates(modelId: string): string[] {
  const candidates = [modelId];
  const lastHyphen = modelId.lastIndexOf('-');
  if (lastHyphen > 0) candidates.push(modelId.slice(0, lastHyphen));
  return candidates;
}

/** Map kickoff mode/assistantType/skillPath to an AiFeature label. */
export function resolveFeatureFromKickoff(kickoff: {
  mode?: string;
  assistantType?: string;
  skillPath?: string;
  standupSessionId?: string;
  pillLabel?: string;
}): AiFeature {
  const { mode, assistantType, skillPath, standupSessionId } = kickoff;

  if (standupSessionId || mode === 'standup-participant' || mode === 'standup-facilitator') return 'standup';
  if (mode === 'development') return 'my-work';

  if (assistantType === 'adr') return 'adr';
  if (assistantType === 'prd') return 'prd';
  if (assistantType === 'design-doc') return 'design-doc';
  if (assistantType === 'calendar-work-item') return 'calendar-work-item-assistant';

  if (skillPath) {
    const lower = skillPath.toLowerCase();
    if (lower.includes('adr-interview') || lower.includes('adr-finalize') || lower.includes('adr-assistant')) {
      return 'adr';
    }
    if (lower.includes('to-prd')) return 'prd';
    if (lower.includes('prd-spec-review')) return 'prd-review';
    if (lower.includes('grill') || lower.includes('interview') || lower.includes('kick-off')) return 'interview';
    if (lower.includes('prd-design-spec') || lower.includes('design-spec-review')) return 'design-doc';
    if (lower.includes('design-doc-validation') || lower.includes('document-validation')) return 'design-doc-validation';
    if (lower.includes('create-test-case')) return 'test-case';
    if (lower.includes('feature-request')) return 'feature-request';
    if (lower.includes('daily-standup')) return 'standup';
  }

  return 'other';
}

export async function resolveUsageEntityFromThread(
  threadId: string,
): Promise<{ entityType: string; entityId: string } | null> {
  const interview = await db.query.interviews.findFirst({
    where: eq(interviews.chatThreadId, threadId),
    columns: { id: true },
  });
  if (interview) return { entityType: 'interview', entityId: interview.id };

  const prd = await db.query.prds.findFirst({
    where: or(
      eq(prds.chatThreadId, threadId),
      eq(prds.prdAssistantThreadId, threadId),
      eq(prds.validationThreadId, threadId),
    ),
    columns: { id: true },
  });
  if (prd) return { entityType: 'prd', entityId: prd.id };

  const adr = await db.query.adrs.findFirst({
    where: or(eq(adrs.chatThreadId, threadId), eq(adrs.adrAssistantThreadId, threadId)),
    columns: { id: true },
  });
  if (adr) return { entityType: 'adr', entityId: adr.id };

  const doc = await db.query.designDocs.findFirst({
    where: or(
      eq(designDocs.chatThreadId, threadId),
      eq(designDocs.docAssistantThreadId, threadId),
      eq(designDocs.validationThreadId, threadId),
    ),
    columns: { id: true },
  });
  if (doc) return { entityType: 'design-doc', entityId: doc.id };

  return null;
}

/** Look up price for a model at a specific time (most recent effective row). */
export async function lookupPricing(provider: string, modelId: string, at: Date): Promise<{
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
} | null> {
  const atStr = at.toISOString();
  for (const candidate of modelIdPricingCandidates(modelId)) {
    const rows = await db
      .select()
      .from(aiPricing)
      .where(
        and(
          eq(aiPricing.provider, provider),
          eq(aiPricing.modelId, candidate),
          lte(aiPricing.effectiveFrom, atStr),
          or(isNull(aiPricing.effectiveTo), gt(aiPricing.effectiveTo, atStr)),
        ),
      )
      .orderBy(desc(aiPricing.effectiveFrom))
      .limit(1);

    if (rows[0]) {
      return {
        inputPerMtok: parseFloat(rows[0].inputPricePerMtok),
        outputPerMtok: parseFloat(rows[0].outputPricePerMtok),
        cacheReadPerMtok: parseFloat(rows[0].cacheReadPricePerMtok),
        cacheWritePerMtok: parseFloat(rows[0].cacheWritePricePerMtok),
      };
    }
  }
  return null;
}

/** Compute cost in USD from token counts and the pricing catalog. */
export async function computeCost(opts: {
  provider: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  at?: Date;
}): Promise<number> {
  const pricing = await lookupPricing(opts.provider, opts.modelId, opts.at ?? new Date());
  if (!pricing) return 0;

  const M = 1_000_000;
  return (
    (opts.inputTokens / M) * pricing.inputPerMtok +
    (opts.outputTokens / M) * pricing.outputPerMtok +
    ((opts.cacheReadTokens ?? 0) / M) * pricing.cacheReadPerMtok +
    ((opts.cacheWriteTokens ?? 0) / M) * pricing.cacheWritePerMtok
  );
}

/** Fire-and-forget insert — never throws. */
export function recordAiUsage(input: RecordUsageInput): void {
  db.insert(aiUsageEvents)
    .values({
      provider: input.provider,
      modelId: input.modelId,
      feature: input.feature,
      project: input.project,
      skillPath: input.skillPath ?? null,
      threadId: input.threadId ?? null,
      runId: input.runId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      workItemId: input.workItemId ?? null,
      userId: input.userId ?? null,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      tokenSource: input.tokenSource,
      costUsd: String(input.costUsd.toFixed(8)),
      costSource: input.costSource,
      durationMs: input.durationMs ?? null,
      status: input.status,
    })
    .catch((err) => {
      console.error('[aiUsageService] Failed to record usage event:', err);
    });
}

export async function recordCursorChatUsage(opts: {
  kickoff: {
    mode?: string;
    assistantType?: string;
    skillPath?: string;
    standupSessionId?: string;
    pillLabel?: string;
    project?: string;
  };
  modelId: string;
  threadId: string;
  runId?: string;
  userId?: string;
  workItemId?: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: AiUsageStatus;
}): Promise<void> {
  const entity = await resolveUsageEntityFromThread(opts.threadId);
  const costUsd = await computeCost({
    provider: 'cursor',
    modelId: opts.modelId,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
  });
  recordAiUsage({
    provider: 'cursor',
    modelId: opts.modelId,
    feature: resolveFeatureFromKickoff(opts.kickoff),
    project: opts.kickoff.project ?? 'unknown',
    skillPath: opts.kickoff.skillPath,
    threadId: opts.threadId,
    runId: opts.runId,
    workItemId: opts.workItemId,
    userId: opts.userId,
    entityType: entity?.entityType,
    entityId: entity?.entityId,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    tokenSource: 'estimated',
    costUsd,
    costSource: 'estimated',
    durationMs: opts.durationMs,
    status: opts.status,
  });
}
